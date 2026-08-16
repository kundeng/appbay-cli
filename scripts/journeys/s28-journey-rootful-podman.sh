#!/usr/bin/env bash
# S28 / issue #58 — the rootful Podman runtime contract, walked end to end.
#
# The alpha runtime matrix is Docker and ROOTFUL Podman. Rootful is the one that had never
# been walked as a whole: the pieces were checked apart, and #58's acceptance criteria are
# specifically about the seams — does `doctor` describe the runtime it was configured for,
# does the ONE server compose template work under both engines, does the healthcheck run in
# an image that has no curl, does data survive a converge.
#
# 🚨 THE CONTROL IS THAT APPBAY BELIEVES IT IS ON PODMAN. An install whose project.yaml has
# no `container_runtime` key believes it is on Docker — that is exactly how the previous
# "rootful Podman regression runs" were recorded green while `appbay up` died with
# `Executable not found in $PATH: "docker"`. R0 asserts the key is on disk before anything
# downstream is allowed to mean anything.
#
#   VM=appbay-podman ./s28-journey-rootful-podman.sh
#
# Requires podman-compose >= 1.5.0 in the VM (1.0.6 cannot parse `configs.content`).
# The install is created under /root and removed on exit.

set -uo pipefail
VM="${VM:-appbay-podman}"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

echo "== S28 rootful Podman journey =="
echo "   VM=$VM"
echo

# multipass is a snap: its daemon cannot read /tmp and cannot read dotfiles in $HOME.
PAYLOAD="$(mktemp -p "$HOME" appbay-journey-payload.XXXXXX)"
cat > "$PAYLOAD" <<'PAYLOAD_EOF'
#!/usr/bin/env bash
set -uo pipefail
r() { printf '%s\n' "$*"; }

export APPBAY_HOME=/root/appbay-s58-journey
rm -rf "$APPBAY_HOME"
cleanup() {
  appbay server stop >/dev/null 2>&1
  podman rm -f appbay.whoami.whoami >/dev/null 2>&1
  rm -rf "$APPBAY_HOME"
}
trap cleanup EXIT

# --- R0: the install is BOUND to podman, on disk ---------------------------------------
appbay init --container-runtime podman > /tmp/j-init.log 2>&1
INIT_RC=$?
if grep -q '^container_runtime: podman' "$APPBAY_HOME/project.yaml" 2>/dev/null; then
  r "R0 ok install-records-container_runtime-podman"
else
  r "R0 fail project.yaml does not record podman (rc=$INIT_RC) :: $(tail -3 /tmp/j-init.log | tr '\n' ' ')"
  exit 0
fi

# --- R1: doctor describes the configured runtime, not a default ------------------------
DOC="$(appbay doctor 2>&1)"
if printf '%s' "$DOC" | grep -qi "podman" && ! printf '%s' "$DOC" | grep -qiE "Install Docker|systemctl start docker"; then
  r "R1 ok doctor-names-podman-and-does-not-advise-installing-docker"
else
  r "R1 fail doctor is not runtime-aware :: $(printf '%s' "$DOC" | grep -iE 'docker' | head -1)"
fi

if printf '%s' "$DOC" | grep -q "All required checks passed"; then
  r "R2 ok doctor-green-on-rootful-podman"
else
  r "R2 fail $(printf '%s' "$DOC" | grep -A1 'Required fixes' | tail -1)"
fi

# --- R3: an unprivileged init on a rootful host says WHICH STORE it bound to ------------
#
# 🚨 THIS IS EXPECTED TO FAIL, and it is the open half of #58 rather than a harness fault.
#
# Rootless and rootful Podman are separate stores. This host runs an active ROOTFUL socket
# (root-owned, 0660) and that is the alpha target — but `appbay init` as an ordinary user
# does not fail, does not warn, and does not consult it: it quietly succeeds against the
# user's ROOTLESS store, creating `appbay_shared` somewhere a rootful deploy cannot see.
# The operator then meets `External network [appbay_shared] does not exists` much later,
# with nothing connecting it to the choice made here.
#
# Nothing on disk records which store an install is bound to, so nothing can warn on a
# switch either. Binding an install to a context — or detecting and refusing — is an owner
# decision, which is why this stays red instead of being papered over.
#
# ⚠️ An earlier version of this ran the same init AS ROOT, where nothing fails and no
# message prints, and reported the absence of the message as the defect. The defect is
# real; that run was not evidence of it.
PRE="$(su ubuntu -c 'APPBAY_HOME=/home/ubuntu/appbay-s58-preflight appbay init --container-runtime podman' 2>&1)"
su ubuntu -c 'rm -rf /home/ubuntu/appbay-s58-preflight' >/dev/null 2>&1
if printf '%s' "$PRE" | grep -qiE "rootless|rootful|separate store|never creates system accounts"; then
  r "R3 ok unprivileged-init-states-the-store-or-privilege-contract"
else
  r "R3 fail unprivileged init bound to the ROOTLESS store silently on a rootful host — no warning, nothing recorded (#58 open decision)"
fi

# --- R4: the app path works under podman -----------------------------------------------
podman rm -f appbay.whoami.whoami >/dev/null 2>&1
appbay up whoami > /tmp/j-up.log 2>&1
if [ "$(podman ps --format '{{.Names}}' | grep -c '^appbay.whoami.whoami$')" -eq 1 ]; then
  r "R4 ok compile-and-apply-produce-a-running-container"
else
  r "R4 fail no container after up :: $(tail -3 /tmp/j-up.log | tr '\n' ' ')"
fi

# --- R5: one provider-neutral server compose, and it becomes HEALTHY --------------------
appbay server start > /tmp/j-server.log 2>&1
timeout 240 bash -c 'until [ "$(podman inspect --format {{.State.Health.Status}} appbay.server 2>/dev/null)" = healthy ]; do sleep 5; done'
H="$(podman inspect --format '{{.State.Health.Status}}' appbay.server 2>/dev/null)"
if [ "$H" = healthy ]; then
  r "R5 ok control-plane-healthy-under-rootful-podman"
else
  r "R5 fail health=$H :: $(tail -3 /tmp/j-server.log | tr '\n' ' ')"
fi

# The healthcheck must use tooling the image actually has. It uses node's fetch precisely
# because curl is absent; asserting on the shape stops a future edit reintroducing curl.
HC="$(podman inspect --format '{{json .Config.Healthcheck}}' appbay.server 2>/dev/null)"
if printf '%s' "$HC" | grep -q "node -e" && ! printf '%s' "$HC" | grep -q "curl"; then
  r "R6 ok healthcheck-uses-tooling-present-in-the-image"
else
  r "R6 fail healthcheck shape: $(printf '%s' "$HC" | head -c 120)"
fi

# --- R7: login round-trips, and survives a converge -------------------------------------
#
# 🚨 THE CONTROL PLANE'S STATE IS NOT SCOPED TO APPBAY_HOME. `appbay server start` mounts
# the named volume `appbay-server_appbay-home` whatever APPBAY_HOME says, so a host that
# has EVER completed first-run setup has signup closed forever and a fresh journey cannot
# create its account. An earlier version of this reported "login produced no session" and
# blamed the product for state left by a previous run.
#
# CLEAN_SERVER=1 makes this a genuinely clean rehearsal, which is what criterion 7 asks
# for. It is opt-in because it DESTROYS the control plane's database — never default.
SIGNUP="$(curl -s -X POST http://localhost:3000/api/auth/signup -H 'content-type: application/json' \
  -d '{"username":"journey","password":"JourneyPass123!"}' 2>/dev/null)"
if printf '%s' "$SIGNUP" | grep -qi "already\|setup"; then
  if [ "${CLEAN_SERVER:-0}" = "1" ]; then
    appbay server stop >/dev/null 2>&1
    podman volume rm -f appbay-server_appbay-home >/dev/null 2>&1
    appbay server start >/dev/null 2>&1
    timeout 240 bash -c 'until [ "$(podman inspect --format {{.State.Health.Status}} appbay.server 2>/dev/null)" = healthy ]; do sleep 5; done'
    SIGNUP="$(curl -s -X POST http://localhost:3000/api/auth/signup -H 'content-type: application/json' \
      -d '{"username":"journey","password":"JourneyPass123!"}' 2>/dev/null)"
  else
    r "R7 skip control-plane already set up on this host; re-run with CLEAN_SERVER=1 for the clean rehearsal"
    r "R8 skip depends on R7"
    exit 0
  fi
fi
C=/tmp/j-cookies
LOGIN="$(curl -s -c $C -X POST http://localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"journey","password":"JourneyPass123!"}' 2>/dev/null)"
UID1="$(printf '%s' "$LOGIN" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
if [ -n "$UID1" ]; then
  r "R7 ok login-round-trips id=${UID1:0:8}"
else
  r "R7 fail login produced no session :: $(printf '%s' "$LOGIN" | head -c 120)"
fi

# 🚨 Data must survive a converge. This is the criterion about volumes not being recreated,
# asserted on REAL data (an account) rather than a marker file — a marker proves the mount
# is there, an account proves the database behind it is the same one.
appbay server stop >/dev/null 2>&1
appbay server start >/dev/null 2>&1
timeout 240 bash -c 'until [ "$(podman inspect --format {{.State.Health.Status}} appbay.server 2>/dev/null)" = healthy ]; do sleep 5; done'
LOGIN2="$(curl -s -X POST http://localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"journey","password":"JourneyPass123!"}' 2>/dev/null)"
UID2="$(printf '%s' "$LOGIN2" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
if [ -n "$UID1" ] && [ "$UID1" = "$UID2" ]; then
  r "R8 ok data-survives-a-converge same-account-id"
else
  r "R8 fail account did not survive restart ('$UID1' -> '$UID2')"
fi
PAYLOAD_EOF

multipass transfer "$PAYLOAD" "$VM:/tmp/rootful-podman.sh" >/dev/null 2>&1 || {
  echo "  ❌ could not transfer the payload to $VM — is the VM running?"; exit 1; }
rm -f "$PAYLOAD"

OUT="$(multipass exec "$VM" -- sudo CLEAN_SERVER="${CLEAN_SERVER:-0}" bash /tmp/rootful-podman.sh 2>&1)"

while IFS= read -r line; do
  case "$line" in
    *" ok "*)   ok  "${line%% ok *}: $(echo "$line" | sed 's/^[^ ]* ok //')" ;;
    *" fail "*) bad "${line%% fail *}: $(echo "$line" | sed 's/^[^ ]* fail //')" ;;
    # A skip is neither. It is printed loudly and counted nowhere, so it can never be
    # mistaken for coverage — but it also does not become a false red.
    *" skip "*) echo "  ⏭  ${line%% skip *}: $(echo "$line" | sed 's/^[^ ]* skip //')" ;;
  esac
done <<< "$OUT"

if [ $((pass + fail)) -eq 0 ]; then
  echo "  ❌ the payload produced no result lines — harness fault, not a product verdict"
  echo "$OUT" | tail -15
  fail=1
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
