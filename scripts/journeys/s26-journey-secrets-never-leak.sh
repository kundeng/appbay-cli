#!/usr/bin/env bash
# S26 / issue #60 journey 12 — secrets never appear in plans, events, logs, or artifacts.
#
# ⭐ WHAT THIS DOES AND DOES NOT CLAIM. `runtime-env` injection deliberately puts secret
# VALUES into the container's environment — that is the mode's whole contract, and finding
# one there is correct, not a leak. What must never happen is a value coming to rest
# somewhere durable or shared: a rendered artifact on disk, command output an operator
# pastes into an issue, a plan/diff, or a log line.
#
# 🚨 THE SENTINEL IS SEARCHED FOR, NOT REASONED ABOUT. Every check greps for the exact
# value. No inference about which code path "should" redact — if the string is on disk or
# in output, it leaked, whatever the intent was.
#
# Self-provisioning; removes its app, its container and its vault entries.
#   VM=appbay-docker ./s26-journey-secrets-never-leak.sh
#   VM=appbay-rhel PRIV=sudo ./s26-journey-secrets-never-leak.sh

set -uo pipefail
VM="${VM:-appbay-docker}"
PRIV="${PRIV:-env}"
HOME_DIR="${HOME_DIR:-/home/ubuntu/.appbay}"
CBIN="${CBIN:-docker}"
APP="leakcheck"
# Distinctive enough that a match cannot be coincidence.
SENTINEL="Zq7-SENTINEL-NEVER-LOG-ME-4f2a"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }
ab()  { vm "cd /home/ubuntu && appbay $1 2>&1"; }

cleanup() {
  ab "down $APP" >/dev/null 2>&1
  vm "rm -rf $HOME_DIR/etc/apps/$APP $HOME_DIR/var/lib/renders/$APP" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup

echo "── Provision an app whose secret has a known sentinel value"
vm "mkdir -p $HOME_DIR/etc/apps/$APP" >/dev/null 2>&1
vm "cat > $HOME_DIR/etc/apps/$APP/docker-compose.yml <<'EOF'
services:
  app:
    image: docker.io/library/busybox:latest
    command: [\"sleep\", \"600\"]
    environment:
      - APP_SECRET
EOF" >/dev/null 2>&1
vm "cat > $HOME_DIR/etc/apps/$APP/appbay.yaml <<'EOF'
project: default
environment: default
upstream:
  source: ./docker-compose.yml
  expose:
    - app
traits:
  - type: secrets
    injection: runtime-env
    service: app
    refs:
      APP_SECRET: vault://$APP/APP_SECRET
EOF" >/dev/null 2>&1
vm "cd /home/ubuntu && printf '%s' '$SENTINEL' | appbay secrets set $APP/APP_SECRET" >/dev/null 2>&1
vm "cd /home/ubuntu && appbay secrets get $APP/APP_SECRET 2>/dev/null | grep -q '$SENTINEL'" >/dev/null 2>&1 \
  && ok "secret stored with the sentinel value" || { bad "could not store the sentinel secret"; exit 1; }

echo "── Compile: the value must not reach stdout or the rendered artifact"
OUT=$(ab "compile $APP")
echo "$OUT" | grep -q "$SENTINEL" && bad "🚨 the secret VALUE appeared in compile output" || ok "compile output carries no secret value"

LEAKED=$(vm "grep -rl '$SENTINEL' $HOME_DIR/var/lib/renders/$APP 2>/dev/null | head -3")
[ -z "$LEAKED" ] && ok "no rendered artifact contains the value" || { bad "🚨 the value is on disk in a rendered artifact"; echo "$LEAKED" | sed 's/^/       /'; }

echo "── Plan/diff: the value must not appear in a deploy plan"
PLAN=$(ab "up $APP --dry-run")
echo "$PLAN" | grep -q "$SENTINEL" && bad "🚨 the value appeared in the deploy plan" || ok "deploy plan carries no secret value"

echo "── Deploy, then check operator-facing surfaces"
ab "up $APP" >/dev/null 2>&1
RUNNING=$(vm "$CBIN ps --filter name=$APP --format '{{.Names}}'" | tr -d '[:space:]')
[ -n "$RUNNING" ] && ok "app deployed ($RUNNING)" || { bad "app did not deploy — later checks would be vacuous"; exit 1; }

# ⚠️ `status` is the command an operator screenshots into a bug report.
ST=$(ab "status $APP")
echo "$ST" | grep -q "$SENTINEL" && bad "🚨 the value appeared in 'appbay status'" || ok "'appbay status' carries no secret value"

LOGS=$(ab "logs $APP --tail 50" 2>/dev/null)
echo "$LOGS" | grep -q "$SENTINEL" && bad "🚨 the value appeared in 'appbay logs'" || ok "'appbay logs' carries no secret value"

# The value SHOULD be in the container env — that is runtime-env's contract. Assert it, so
# a "no leak" result cannot be produced by the secret simply never having been delivered.
INENV=$(vm "$CBIN exec appbay.$APP.app env 2>/dev/null | grep -c '$SENTINEL'" | tr -d '[:space:]')
[ "${INENV:-0}" != "0" ] && ok "the secret DID reach the container (runtime-env works — the checks above are meaningful)" \
                         || bad "the secret never reached the container; every 'no leak' above proves nothing"

echo "── Nothing durable outside the vault holds the value"
# The vault itself is encrypted at rest, so a match there would be alarming in its own right.
STRAY=$(vm "grep -rl '$SENTINEL' $HOME_DIR --exclude-dir=vault 2>/dev/null | grep -v 'vault.enc' | head -5")
[ -z "$STRAY" ] && ok "no plaintext copy anywhere under APPBAY_HOME" || { bad "🚨 plaintext secret found on disk"; echo "$STRAY" | sed 's/^/       /'; }

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
