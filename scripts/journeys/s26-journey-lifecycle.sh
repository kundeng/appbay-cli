#!/usr/bin/env bash
# S26 / issue #60 journey 11 — start/stop/restart and status transitions.
#
# ⭐ THE INTERESTING RISK IS NOT "DOES STOP WORK" — it is whether STATUS TELLS THE TRUTH
# AFTERWARDS. AppBay keeps a SQLite cache alongside the filesystem, so a status that reads
# its own bookkeeping instead of the runtime would report an app "running" after the
# container died, and an operator would trust it. Every transition below is therefore
# checked twice: what AppBay says, and what the container runtime actually holds.
#
# 🚨 RESTART IS CHECKED BY IDENTITY, NOT BY LIVENESS. A container that was never restarted
# is also "running", so `Up` proves nothing. This compares the container's StartedAt across
# the call — the only evidence that a restart happened at all.
#
# Self-provisioning; removes its app and container.
#   VM=appbay-docker ./s26-journey-lifecycle.sh
#   VM=appbay-rhel PRIV=sudo CBIN=podman ./s26-journey-lifecycle.sh

set -uo pipefail
VM="${VM:-appbay-docker}"
PRIV="${PRIV:-env}"
HOME_DIR="${HOME_DIR:-/home/ubuntu/.appbay}"
CBIN="${CBIN:-docker}"
APP="lifecycle-probe"
CTR="appbay.$APP.app"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }
ab()  { vm "cd /home/ubuntu && appbay $1 2>&1"; }

runtime_state() { vm "$CBIN inspect $CTR --format '{{.State.Status}}' 2>/dev/null || echo absent" | tr -d '[:space:]'; }
started_at()    { vm "$CBIN inspect $CTR --format '{{.State.StartedAt}}' 2>/dev/null || echo none" | tr -d '[:space:]'; }

cleanup() {
  ab "down $APP" >/dev/null 2>&1
  vm "$CBIN rm -f $CTR >/dev/null 2>&1; rm -rf $HOME_DIR/etc/apps/$APP $HOME_DIR/var/lib/renders/$APP" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup

echo "── Provision and deploy"
vm "mkdir -p $HOME_DIR/etc/apps/$APP" >/dev/null 2>&1
vm "cat > $HOME_DIR/etc/apps/$APP/docker-compose.yml <<'EOF'
services:
  app:
    image: docker.io/library/busybox:latest
    command: [\"sleep\", \"600\"]
EOF" >/dev/null 2>&1
vm "cat > $HOME_DIR/etc/apps/$APP/appbay.yaml <<'EOF'
project: default
environment: default
upstream:
  source: ./docker-compose.yml
  expose:
    - app
EOF" >/dev/null 2>&1

ab "up $APP" >/dev/null 2>&1
[ "$(runtime_state)" = "running" ] && ok "deployed and running in the runtime" || { bad "app did not start; the rest would be vacuous"; exit 1; }
# ⚠️ `appbay ps`, NOT `appbay status <app>`. Per-app `status` is a CONFIGURATION view —
# directory, project, services, traits — and never mentions running state at all. An
# earlier version of this journey asserted running-ness against it, so three checks passed
# VACUOUSLY: a command that never says "running" trivially satisfies "no longer says
# running". Runtime state lives in `ps`.
ab "ps" | grep -E "^\\s*$APP\\s" | grep -qi running && ok "ps agrees: running" || bad "ps does NOT report running while the container is up"

echo "── Stop"
ab "down $APP" >/dev/null 2>&1
STATE=$(runtime_state)
[ "$STATE" = "absent" ] || [ "$STATE" = "exited" ] && ok "container is gone/exited in the runtime ($STATE)" \
                                                   || bad "container is still $STATE after down"
# ⚠️ The point of the journey: after a stop, status must NOT still claim running.
PS=$(ab "ps")
echo "$PS" | grep -E "^\s*$APP\s" | grep -qi running && bad "🚨 ps still reports running after down — it is reading cache, not reality" \
                                                       || ok "ps no longer lists it as running"

echo "── Start again"
ab "up $APP" >/dev/null 2>&1
[ "$(runtime_state)" = "running" ] && ok "running again after a second up" || bad "app did not come back up"

echo "── Restart must actually replace the process"
BEFORE=$(started_at)
sleep 2
ab "restart $APP" >/dev/null 2>&1
AFTER=$(started_at)
[ "$(runtime_state)" = "running" ] && ok "still running after restart" || bad "app is not running after restart"
# 🚨 StartedAt is the only proof. "Up" is equally true of a container that was never touched.
[ "$BEFORE" != "$AFTER" ] && [ "$AFTER" != "none" ] && ok "StartedAt advanced — the container really was restarted" \
                                                    || bad "StartedAt unchanged ($BEFORE) — restart reported success without restarting"

echo "── Status survives a runtime-side change AppBay did not make"
# An operator (or a crash) can stop a container behind AppBay's back. Status must notice.
vm "$CBIN stop $CTR" >/dev/null 2>&1
PS=$(ab "ps")
echo "$PS" | grep -E "^\s*$APP\s" | grep -qi running && bad "🚨 ps reports running after the container was stopped OUT OF BAND" \
                                                      || ok "ps notices an out-of-band stop"

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
