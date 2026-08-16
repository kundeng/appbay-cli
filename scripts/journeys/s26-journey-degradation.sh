#!/usr/bin/env bash
# S26 / issue #60 journey 15 — backup, hooks, overlay and GPU graceful degradation.
#
# ⭐ "GRACEFUL DEGRADATION" IS WHAT MAKES THIS TESTABLE WITHOUT THE HARDWARE. The GPU half of
# this journey was assumed to need a GPU. It does not: the property under test is what
# happens when the capability is ABSENT, and absence is the state of every machine here. A
# host with no GPU must produce a CLEAR REFUSAL naming the missing capability — not a
# silent deploy that starts a container which then cannot see a device.
#
# 🚨 THE FAILURE MODE THIS GUARDS IS THE EXPENSIVE ONE. An app that deploys "successfully"
# without its GPU looks healthy in every listing and fails only when a model load times out
# — hours later, far from the cause.
#
#   VM=appbay-docker ./s26-journey-degradation.sh
#   VM=appbay-rhel PRIV=sudo CBIN=podman ./s26-journey-degradation.sh

set -uo pipefail
VM="${VM:-appbay-docker}"
PRIV="${PRIV:-env}"
HOME_DIR="${HOME_DIR:-/home/ubuntu/.appbay}"
CBIN="${CBIN:-docker}"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }
ab()  { vm "cd /home/ubuntu && appbay $1 2>&1"; }

fixture() { # $1 name, $2 traits block
  vm "mkdir -p $HOME_DIR/etc/apps/$1" >/dev/null 2>&1
  vm "cat > $HOME_DIR/etc/apps/$1/docker-compose.yml <<'EOF'
services:
  app:
    image: docker.io/library/busybox:latest
    command: [\"sleep\", \"300\"]
    volumes:
      - appdata:/data
volumes:
  appdata: {}
EOF" >/dev/null 2>&1
  vm "cat > $HOME_DIR/etc/apps/$1/appbay.yaml <<EOF
project: default
environment: default
upstream:
  source: ./docker-compose.yml
  expose:
    - app
traits:
$2
EOF" >/dev/null 2>&1
}

cleanup() {
  for a in degr-bk degr-gpu degr-hooks; do
    ab "down $a" >/dev/null 2>&1
    vm "rm -rf $HOME_DIR/etc/apps/$a $HOME_DIR/var/lib/renders/$a" >/dev/null 2>&1
  done
}
trap cleanup EXIT
cleanup

echo "── GPU absent: the refusal must NAME the missing capability"
HAS_GPU=$(vm "command -v nvidia-smi >/dev/null 2>&1 && echo yes || echo no" | tr -d '[:space:]')
fixture "degr-gpu" "  - type: gpu
    service: app"
OUT=$(ab "compile degr-gpu")
if [ "$HAS_GPU" = "no" ]; then
  echo "$OUT" | grep -qiE "gpu" && ok "compile refuses and names GPU" \
                                || { bad "🚨 a GPU trait compiled clean on a host with no GPU"; echo "$OUT" | tail -3 | sed 's/^/       /'; }
  # 🚨 The important half: refusing must also mean NOT deploying. A clear error followed by
  # a running container is worse than either alone.
  ab "up degr-gpu" >/dev/null 2>&1
  ST=$(vm "$CBIN inspect appbay.degr-gpu.app --format '{{.State.Status}}' 2>/dev/null || echo absent" | tr -d '[:space:]')
  [ "$ST" = "absent" ] && ok "…and no container was started anyway" \
                       || bad "🚨 the app deployed without its GPU — it will fail hours later, far from the cause"
else
  echo "     ⏭ this host HAS a GPU; the absence path cannot be exercised here"
  ok "GPU present — degradation path not applicable on this host"
fi

echo "── Backup trait compiles and yields a schedule the queue can act on"
fixture "degr-bk" "  - type: backup
    schedule: \"0 2 * * *\"
    retention: 7"
OUT=$(ab "compile degr-bk")
echo "$OUT" | grep -qE "Compile errors:|[1-9][0-9]* error\(s\)" && { bad "backup trait failed to compile"; echo "$OUT" | tail -3 | sed 's/^/       /'; } \
                                                               || ok "backup trait compiles"
# The trait is metadata-only by design: it must NOT alter the compose output.
# ⚠️ The app is named `degr-bk`, NOT `degr-backup`, on purpose. With the obvious name, a
# grep for "backup" matched the app's OWN name in container_name and network aliases and
# reported a leak that did not exist — an assertion that cannot distinguish the thing under
# test from its label is not an assertion.
vm "grep -qiE 'schedule|retention|0 2 \\* \\* \\*' $HOME_DIR/var/lib/renders/degr-bk/docker-compose.rendered.yml" >/dev/null 2>&1 \
  && bad "the backup trait leaked into the rendered compose — it is metadata-only by design" \
  || ok "backup stays out of the compose (metadata-only, as designed)"

echo "── Hooks and overlays still degrade correctly (regression)"
# Both are covered in depth elsewhere (hooks: issue #56 re-proven; overlays: BDD). Here we
# only confirm an app carrying a hook still compiles on this runtime.
fixture "degr-hooks" "  - type: hooks
    pattern: init
    image: docker.io/library/busybox:latest
    command: \"true\"
    volumes:
      - appdata:/data"
OUT=$(ab "compile degr-hooks")
echo "$OUT" | grep -qE "Compile errors:|[1-9][0-9]* error\(s\)" && { bad "hooks trait failed to compile"; echo "$OUT" | tail -3 | sed 's/^/       /'; } \
                                                               || ok "hooks trait compiles"
vm "grep -q 'degr-hooks_appdata' $HOME_DIR/var/lib/renders/degr-hooks/docker-compose.rendered.yml" >/dev/null 2>&1 \
  && ok "hook volume is namespaced (issue #56 stays fixed)" \
  || bad "hook volume is not namespaced — #56 has regressed"

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
