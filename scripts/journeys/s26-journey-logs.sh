#!/usr/bin/env bash
# S26 / issue #60 journey 10 — logs show REAL container output, and fail clearly otherwise.
#
# ⭐ THIS PROJECT HAS SHIPPED FAKE LOGS BEFORE. `logs-tab.tsx` cycled a hardcoded LOG_LINES
# array while real SSE wiring sat unused, so the UI looked alive on an install with nothing
# running. That is why this journey does not check "did output appear" — output always
# appears if something is willing to invent it. It plants a SENTINEL inside the container
# and requires that exact string back.
#
# 🚨 AND THE FAILURE CASES MATTER AS MUCH. Logs for an app that does not exist, or whose
# container is gone, must say so. Empty output with exit 0 is the worst answer: it looks
# like a healthy, quiet app.
#
# Self-provisioning; removes its app and container.
#   VM=appbay-docker ./s26-journey-logs.sh
#   VM=appbay-rhel PRIV=sudo CBIN=podman ./s26-journey-logs.sh

set -uo pipefail
VM="${VM:-appbay-docker}"
PRIV="${PRIV:-env}"
HOME_DIR="${HOME_DIR:-/home/ubuntu/.appbay}"
CBIN="${CBIN:-docker}"
APP="logprobe"
CTR="appbay.$APP.app"
SENTINEL="LOGLINE-8b31-REAL-CONTAINER-OUTPUT"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }
ab()  { vm "cd /home/ubuntu && appbay $1 2>&1"; }
rc()  { vm "cd /home/ubuntu && appbay $1 >/dev/null 2>&1; echo \$?" | tr -d '[:space:]'; }

cleanup() {
  ab "down $APP" >/dev/null 2>&1
  vm "$CBIN rm -f $CTR >/dev/null 2>&1; rm -rf $HOME_DIR/etc/apps/$APP $HOME_DIR/var/lib/renders/$APP" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup

echo "── Deploy an app that prints a known sentinel"
vm "mkdir -p $HOME_DIR/etc/apps/$APP" >/dev/null 2>&1
vm "cat > $HOME_DIR/etc/apps/$APP/docker-compose.yml <<'EOF'
services:
  app:
    image: docker.io/library/busybox:latest
    command: [\"sh\", \"-c\", \"echo $SENTINEL; sleep 600\"]
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
sleep 3
STATE=$(vm "$CBIN inspect $CTR --format '{{.State.Status}}' 2>/dev/null || echo absent" | tr -d '[:space:]')
[ "$STATE" = "running" ] && ok "app deployed and running" || { bad "app did not start; the rest would be vacuous"; exit 1; }

echo "── Logs must contain the container's ACTUAL output"
OUT=$(ab "logs $APP --tail 50")
echo "$OUT" | grep -q "$SENTINEL" && ok "the sentinel the container printed came back" \
                                  || { bad "🚨 the container's real output is NOT in 'appbay logs'"; echo "$OUT" | tail -4 | sed 's/^/       /'; }

# ⚠️ Cross-check against the runtime. If these disagree, AppBay is not reading the runtime.
RAW=$(vm "$CBIN logs $CTR 2>&1 | head -5")
echo "$RAW" | grep -q "$SENTINEL" && ok "the runtime agrees the line exists (not an AppBay artefact)" \
                                  || bad "the runtime does not have the line — the fixture is wrong, not the product"

echo "── A nonexistent app must fail clearly, not return empty success"
RCODE=$(rc "logs definitely-not-an-app --tail 5")
OUT=$(ab "logs definitely-not-an-app --tail 5")
[ "$RCODE" != "0" ] && ok "nonexistent app: non-zero exit ($RCODE)" \
                    || bad "🚨 nonexistent app exited 0 — empty output looks like a quiet, healthy app"
echo "$OUT" | grep -qi "definitely-not-an-app" && ok "…and the message names the app" \
                                              || bad "…but the message does not name the app"

echo "── A stopped container must not silently return nothing"
vm "$CBIN stop $CTR" >/dev/null 2>&1
OUT=$(ab "logs $APP --tail 50")
# Either the historical log survives (compose keeps it) or the tool says the app is not
# running. Both are honest; silence with success is not.
if echo "$OUT" | grep -q "$SENTINEL"; then
  ok "stopped app: historical output still returned (honest)"
elif echo "$OUT" | grep -qiE "not running|no container|stopped|not found"; then
  ok "stopped app: reported as not running (honest)"
else
  bad "🚨 stopped app returned neither output nor an explanation"
  echo "$OUT" | tail -3 | sed 's/^/       /'
fi

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
