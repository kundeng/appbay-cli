#!/usr/bin/env bash
# S25 task 20 — "Stop all AppBay interfaces; verify edge and app remain healthy."
#
# ⭐ THE CLAIM UNDER TEST IS THE OPTIONALITY DOCTRINE: AppBay is a DEPLOYER, not a runtime
# dependency. The CLI calls @appbay/core in-process and exits; the optional web control
# plane is a separate container. Once an app and the edge are up, nothing AppBay owns needs
# to be running for requests to keep being served.
#
# 🚨 A DOCTRINE NOBODY TESTS IS A SLOGAN. The failure this catches is an edge or app that
# quietly acquired a dependency on the control plane — a socket the CLI must hold, a
# generated file re-rendered on each invocation, a container with an implicit ordering
# edge. That failure is invisible while any interface happens to be running, which is the
# normal state during development, so it can only be seen by taking every interface away.
#
# ⚠️ STOPPING IS NOT ENOUGH — the binary is MOVED ASIDE. "Stopped" for a CLI is just its
# steady state (it already exited), so a test that merely observes no process running
# proves nothing at all. Removing the executable is the honest form of "all interfaces
# stopped": AppBay is, for the duration, not installed.
#
# Usage:  VM=appbay-docker ./s25-interface-optionality.sh                 # self-provisioning
#         VM=appbay-podman PRIV=sudo CBIN=podman ./s25-interface-optionality.sh
#         HOST=whoami.test.local ./s25-interface-optionality.sh          # probe an existing app
#
# ⭐ SELF-PROVISIONING, because a journey that needs a hand-seeded host cannot satisfy the
# both-runtimes requirement. It used to default HOST to `whoami.test.local` and probe
# whatever happened to be deployed. On the Docker VM someone had once added that name to
# /etc/hosts and left a gated app running, so it passed; on the Podman VM it returned 000
# for both probes and reported the PRODUCT as broken. With no HOST given it now creates its
# own gated app and hosts entry, and removes both on exit.

set -uo pipefail
VM="${VM:-appbay-docker}"
# ⚠️ PRIV, or every container query runs unprivileged. On a ROOTFUL Podman host that reads
# the empty ROOTLESS store, so `CONTAINERS_BEFORE` and `CONTAINERS_AFTER` were both "" and
# "same containers running" compared nothing to nothing — a vacuous pass waiting to happen,
# next to two real failures.
PRIV="${PRIV:-env}"
APP="${APP:-optionality-probe}"
HOST="${HOST:-}"
# ⚠️ The container CLI is a parameter. This script predated the runtime matrix and hardcoded
# `docker`; on the Podman host every container query printed "docker: command not found" and
# silently returned nothing.
CBIN="${CBIN:-docker}"
HOME_DIR="${HOME_DIR:-/home/ubuntu/.appbay}"
# 🚨 ASK THE TARGET WHERE THE BINARY IS. Do not derive it from HOME_DIR — that is the DATA
# directory, and install.sh puts the executable on PATH (/usr/local/bin or ~/.local/bin).
# Deriving it gave /root/appbay on the rootful host, which does not exist, so phase 3
# reported "binary already absent" and cheerfully passed "AppBay CLI is not installed"
# WITHOUT EVER MOVING ANYTHING — the entire point of the journey skipped, and only phase 5
# noticed, as "nothing to restore".
#
# ⚠️ That is the vacuous-pass shape rule 3 warns about: phases 3 and 4 would have gone green
# on a host where AppBay was never removed at all.
BIN="${BIN:-}"
if [ -z "$BIN" ]; then
  BIN="$(multipass exec "$VM" -- ${PRIV:-env} bash -c 'command -v appbay' 2>/dev/null | tr -d '[:space:]')"
fi
[ -n "$BIN" ] || { echo "  ❌ appbay is not on PATH in $VM — nothing to move aside"; exit 1; }

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }
CLI_CWD="$(dirname "$HOME_DIR")"
ab()  { multipass exec "$VM" -- $PRIV bash -c "cd $CLI_CWD && APPBAY_HOME=$HOME_DIR appbay $1 2>&1"; }

PROVISIONED=no
cleanup() {
  [ "$PROVISIONED" = yes ] || return 0
  ab "down $APP" >/dev/null 2>&1
  vm "rm -rf $HOME_DIR/etc/apps/$APP $HOME_DIR/var/lib/renders/$APP \
      $HOME_DIR/etc/apps/caddy/config/dynamic/$APP.caddy \
      $HOME_DIR/etc/apps/caddy/config/dynamic/auth/$APP-*.caddy \
      $HOME_DIR/etc/apps/caddy/config/security/policies/$APP.caddy" >/dev/null 2>&1
  vm "sudo sed -i '/ $HOST\$/d' /etc/hosts" >/dev/null 2>&1
}
trap cleanup EXIT

if [ -z "$HOST" ]; then
  DOMAIN=$(vm "grep -m1 '^domain:' $HOME_DIR/project.yaml | awk '{print \$2}'" | tr -d '[:space:]')
  [ -n "$DOMAIN" ] || { echo "  ❌ could not read domain from $HOME_DIR/project.yaml"; exit 1; }
  HOST="$APP.$DOMAIN"
  vm "mkdir -p $HOME_DIR/etc/apps/$APP" >/dev/null 2>&1
  vm "cat > $HOME_DIR/etc/apps/$APP/docker-compose.yml <<'EOF'
services:
  app:
    image: docker.io/traefik/whoami:latest
EOF" >/dev/null 2>&1
  vm "cat > $HOME_DIR/etc/apps/$APP/appbay.yaml <<EOF
project: default
environment: default
upstream:
  source: ./docker-compose.yml
  expose:
    - app
traits:
  - type: ingress
    host: \"$HOST\"
    port: 80
    service: app
    exposure: internal
  - type: auth
    policy: authenticated
EOF" >/dev/null 2>&1
  # Resolve the name INSIDE the VM. Never the workstation's /etc/hosts — a test must not
  # require modifying the machine it is launched from.
  vm "grep -q ' $HOST\$' /etc/hosts || echo '127.0.0.1 $HOST' | sudo tee -a /etc/hosts >/dev/null"
  ab "up $APP" >/dev/null 2>&1
  PROVISIONED=yes
fi

# Probe the edge from INSIDE the VM: this test is about whether the app keeps serving, not
# about workstation networking. `-k` because local domains carry a self-signed wildcard.
probe() { vm "curl -sk -o /dev/null -w '%{http_code}' --max-time 10 'https://$HOST$1'"; }
# ⚠️ `/auth` legitimately 302s to `/auth/login`; only the followed chain ends at the form.
# Asserting 200 on the un-followed request marks a working portal as broken.
probe_final() { vm "curl -skL -o /dev/null -w '%{http_code}' --max-time 15 'https://$HOST$1'"; }

echo "── Phase 1: baseline — the edge serves while AppBay is installed"
GATED_BEFORE=$(probe "/")
PORTAL_BEFORE=$(probe_final "/auth")
CONTAINERS_BEFORE=$(vm "$CBIN ps --format '{{.Names}}' | sort | tr '\n' ' '")
echo "     gated app: $GATED_BEFORE · portal: $PORTAL_BEFORE"
echo "     running:   $CONTAINERS_BEFORE"
# 302 is the CORRECT answer for an unauthenticated request to a gated app — it means the
# authorization policy is loaded and enforcing. A 200 here would mean the gate is inert.
[ "$GATED_BEFORE" = "302" ] && ok "gated app redirects to the portal (policy enforcing)" \
                           || bad "gated app returned $GATED_BEFORE, expected 302"
[ "$PORTAL_BEFORE" = "200" ] && ok "portal serves the login form (following /auth -> /auth/login)" || bad "portal returned $PORTAL_BEFORE"

# 🚨 ABORT IF THE BASELINE IS NOT HEALTHY. Everything below is a BEFORE/AFTER COMPARISON,
# and a comparison between two broken states reports success. That is exactly what happened
# on the Podman host: the wrong default HOST made both probes return 000, and this journey
# cheerfully reported "gated app unchanged (000)" three times. A before/after test must
# first prove that "before" is good, or it certifies nothing.
if [ "$GATED_BEFORE" != "302" ] || [ "$PORTAL_BEFORE" != "200" ]; then
  echo
  echo "  ⛔ ABORTING: the baseline is not serving (gated=$GATED_BEFORE portal=$PORTAL_BEFORE)."
  echo "     Comparing an unhealthy before to an unhealthy after would PASS and mean nothing."
  echo "     Check HOST=$HOST resolves on $VM, and that the edge and app are up."
  echo
  echo "──────── $pass passed, $fail failed (aborted before the comparison) ────────"
  exit 1
fi

echo "── Phase 2: inventory every AppBay interface"
SERVER_RUNNING=$(vm "$CBIN ps --format '{{.Names}}' | grep -c '^appbay\.server$'" | tr -d '[:space:]')
PROCS=$(vm "pgrep -xc appbay 2>/dev/null || true" | tr -d '[:space:]')
echo "     web control-plane containers: ${SERVER_RUNNING:-0} · CLI processes: ${PROCS:-0}"

echo "── Phase 3: remove every interface (move the binary aside)"
# ⚠️ sudo. The binary lives on PATH (/usr/local/bin), which is root-owned, so an
# unprivileged `mv` fails with "Permission denied" — and the previous version swallowed
# that into "binary already absent" and then asserted the CLI was gone. On the Docker host
# it "passed" only because BIN pointed at a stray copy at /home/ubuntu/appbay: the journey
# moved an inert file while the real CLI stayed fully installed, and phases 3 and 4 proved
# nothing about optionality at all. Two vacuous passes, in the journey whose own rule 3 is
# "prove the check can fail".
vm "sudo test -x $BIN && sudo mv $BIN $BIN.absent && echo moved || echo 'binary already absent'"
vm "$CBIN stop appbay.server >/dev/null 2>&1 || true"
ABSENT=$(vm "test -x $BIN && echo present || echo absent" | tr -d '[:space:]')
# The binary must ALSO be gone from PATH resolution, not merely from one path.
ON_PATH=$(vm "command -v appbay >/dev/null 2>&1 && echo yes || echo no" | tr -d '[:space:]')
[ "$ON_PATH" = "no" ] || bad "appbay is still resolvable on PATH ($(vm 'command -v appbay'))"
[ "$ABSENT" = "absent" ] && ok "AppBay CLI is not installed" || bad "CLI still present"
STILL_RUNNING=$(vm "$CBIN ps --format '{{.Names}}' | grep -c '^appbay\.server$'" | tr -d '[:space:]')
[ "${STILL_RUNNING:-0}" = "0" ] && ok "no AppBay control plane is running" \
                               || bad "$STILL_RUNNING control-plane container(s) still up"

echo "── Phase 4: with AppBay gone, does the app still serve?"
GATED_AFTER=$(probe "/")
PORTAL_AFTER=$(probe_final "/auth")
CONTAINERS_AFTER=$(vm "$CBIN ps --format '{{.Names}}' | sort | tr '\n' ' '")
echo "     gated app: $GATED_AFTER · portal: $PORTAL_AFTER"
echo "     running:   $CONTAINERS_AFTER"
[ "$GATED_AFTER" = "$GATED_BEFORE" ] && ok "gated app unchanged ($GATED_AFTER)" \
                                     || bad "gated app changed: $GATED_BEFORE -> $GATED_AFTER"
[ "$PORTAL_AFTER" = "$PORTAL_BEFORE" ] && ok "portal unchanged ($PORTAL_AFTER)" \
                                       || bad "portal changed: $PORTAL_BEFORE -> $PORTAL_AFTER"
[ "$CONTAINERS_AFTER" = "$CONTAINERS_BEFORE" ] && ok "same containers running" \
                                               || bad "container set changed"

echo "── Phase 5: restore the binary"
vm "sudo test -x $BIN.absent && sudo mv $BIN.absent $BIN && echo restored || echo 'nothing to restore'"
RESTORED=$(vm "test -x $BIN && echo present || echo absent" | tr -d '[:space:]')
[ "$RESTORED" = "present" ] && ok "CLI restored" || bad "CLI NOT restored — fix by hand"

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
