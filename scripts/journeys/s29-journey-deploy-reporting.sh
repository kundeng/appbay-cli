#!/usr/bin/env bash
# S29 / appbay-cli#4 + appbay-cli#5 — the deploy summary reports the DEPLOYMENT.
#
# Two bugs, one root cause: a verdict about one question was printed as the answer to
# another.
#
#   #4  `[UNCHANGED]` is a verdict about the COMPILED ARTIFACT. It was being summed into
#       "N deployed". With the container removed first, `appbay up whoami` created and
#       started it and reported `0 deployed, 1 unchanged`.
#
#   #5  `no such object: appbay.caddy` is the ENGINE saying the container to exec into does
#       not exist. It was rendered as "Caddy configuration rejected" — a verdict about a
#       configuration that was never read.
#
# ⭐ THE CONTROLS ARE THE POINT. R2 asserts a genuinely idempotent converge STILL reports
# `0 deployed` — without it, a fix that simply always says "deployed" would pass. R4
# asserts the plan is still UNCHANGED on the converge that must report a deployment, so we
# are provably testing the divergent case and not a recompile.
#
#   VM=appbay-docker ./s29-journey-deploy-reporting.sh
#   VM=appbay-rhel PRIV=sudo CBIN=podman HOME_DIR=/root/.appbay ./s29-journey-deploy-reporting.sh
#
# Leaves nothing behind: both scratch APPBAY_HOMEs and every container are removed on exit.

set -uo pipefail
VM="${VM:-appbay-docker}"
PRIV="${PRIV:-env}"
CBIN="${CBIN:-docker}"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }

echo "== S29 deploy-reporting journey (appbay-cli#4, #5) =="
echo "   VM=$VM  CBIN=$CBIN"
echo

# multipass runs as a snap: its daemon cannot read /tmp and the `home` interface hides
# DOTFILES. Stage in $HOME under a non-hidden name.
PAYLOAD="$(mktemp -p "$HOME" appbay-journey-payload.XXXXXX)"
cat > "$PAYLOAD" <<PAYLOAD_HEADER
#!/usr/bin/env bash
CBIN="$CBIN"
PAYLOAD_HEADER
cat >> "$PAYLOAD" <<'PAYLOAD_EOF'
set -uo pipefail
r() { printf '%s\n' "$*"; }

W="$HOME/deploy-reporting-journey"
rm -rf "$W"; mkdir -p "$W"
APP=reportprobe
CTR="appbay.$APP.probe"

RUNTIME_FLAG=""
[ "$CBIN" = podman ] && RUNTIME_FLAG="--container-runtime podman"

# 🚨 THE EDGE IS SHARED HOST STATE AND MUST BE PUT BACK. The first version of Part B ran
# `rm -f appbay.caddy` to create the "edge not deployed" condition. That is not this
# journey's container — it belongs to the host install — and deleting it took out three
# unrelated journeys in the next sweep (s25-edge-authz, s25-interface-optionality,
# s26-journey-aux-transactional) with failures that looked like product defects.
#
# STOPPING it is enough: a stopped edge is "the validator cannot run" just as much as an
# absent one, and it is reversible. EDGE_WAS_RUNNING records what to restore.
EDGE_CTR=""
EDGE_WAS_RUNNING=0
for c in appbay.caddy.caddy appbay.caddy; do
  if "$CBIN" inspect "$c" >/dev/null 2>&1; then
    EDGE_CTR="$c"
    [ "$("$CBIN" inspect --format '{{.State.Running}}' "$c" 2>/dev/null)" = "true" ] && EDGE_WAS_RUNNING=1
    break
  fi
done

cleanup() {
  "$CBIN" rm -f "$CTR" >/dev/null 2>&1
  # Put the host's edge back exactly as we found it.
  if [ -n "$EDGE_CTR" ] && [ "$EDGE_WAS_RUNNING" = "1" ]; then
    "$CBIN" start "$EDGE_CTR" >/dev/null 2>&1
  fi
  rm -rf "$W"
}
trap cleanup EXIT

# Registry-qualified on purpose: RHEL-family hosts set short-name-mode=enforcing and an
# unqualified name dies with "cannot prompt without a TTY" (exit 125).
write_app() {  # $1 = APPBAY_HOME, $2 = extra appbay.yaml body
  local D="$1/etc/apps/$APP"
  mkdir -p "$D"
  cat > "$D/docker-compose.yml" <<'EOF'
services:
  probe:
    image: docker.io/library/alpine:3.20
    command: ["sleep", "3600"]
EOF
  {
    echo "project: default"
    echo "environment: default"
    echo "upstream:"
    echo "  source: ./docker-compose.yml"
    echo "  expose:"
    echo "    - probe"
    printf '%s' "$2"
  } > "$D/appbay.yaml"
}

container_id()    { "$CBIN" inspect --format '{{.Id}}' "$CTR" 2>/dev/null; }
container_state() { "$CBIN" inspect --format '{{.State.Status}}' "$CTR" 2>/dev/null; }
deployed_count()  { sed -n 's/^\([0-9]\+\) deployed.*/\1/p' "$1" | tail -1; }

# =======================================================================================
# Part A — appbay-cli#4: the summary counts the deployment, not the artifact
# =======================================================================================
export APPBAY_HOME="$W/home-a"
appbay init $RUNTIME_FLAG >/dev/null 2>&1 || { r "SETUP fail init-a-failed"; exit 1; }
write_app "$APPBAY_HOME" ""

# --- first converge: a genuinely new app --------------------------------------------
appbay up "$APP" > "$W/a1.log" 2>&1
D1="$(deployed_count "$W/a1.log")"
if [ "$(container_state)" = "running" ] && [ "${D1:-0}" -ge 1 ]; then
  r "R1 ok first-converge-deploys reported=$D1 state=running"
else
  r "R1 fail rc-state='$(container_state)' reported='${D1:-none}' :: $(tail -3 "$W/a1.log" | tr '\n' ' ')"
  exit 0
fi
ID1="$(container_id)"

# --- CONTROL: a converge that really does nothing must still report 0 deployed --------
# Without this, "always say deployed" would pass the assertion that matters.
appbay up "$APP" > "$W/a2.log" 2>&1
D2="$(deployed_count "$W/a2.log")"
ID2="$(container_id)"
if [ "${D2:-x}" = "0" ] && [ "$ID2" = "$ID1" ]; then
  r "R2 ok CONTROL idempotent-converge-still-reports-0-deployed"
else
  r "R2 fail idempotent converge reported '${D2:-none}' deployed (container id ${ID1:0:12} -> ${ID2:0:12}) — the check cannot discriminate"
fi

# --- THE BUG: remove the container, converge again ------------------------------------
"$CBIN" rm -f "$CTR" >/dev/null 2>&1
BEFORE="$(container_state)"
appbay up "$APP" > "$W/a3.log" 2>&1
D3="$(deployed_count "$W/a3.log")"
AFTER="$(container_state)"

if [ -z "$BEFORE" ] && [ "$AFTER" = "running" ]; then
  r "R3 ok converge-recreated-the-missing-container (0 before, running after)"
else
  r "R3 fail expected no container before and running after; got before='$BEFORE' after='$AFTER'"
fi

# This is the assertion the issue was filed on. It read `0 deployed` for years of runs.
if [ "${D3:-0}" -ge 1 ]; then
  r "R4 ok summary-reports-the-deployment reported=$D3"
else
  r "R4 fail summary said '${D3:-none} deployed' for a converge that STARTED a container"
fi

# --- CONTROL: and the plan really was UNCHANGED on that run ---------------------------
# If the plan had recompiled, R4 would pass for an uninteresting reason.
if grep -q "plan: UNCHANGED" "$W/a3.log"; then
  r "R5 ok CONTROL plan-was-UNCHANGED-while-the-deployment-was-not"
else
  r "R5 fail the recreating converge did not report an UNCHANGED plan — wrong case under test :: $(grep -i 'plan:' "$W/a3.log" | tr '\n' ' ')"
fi

# `[UNCHANGED]` must no longer stand alone as though it described the deployment.
if grep -qE '\[(NEW|CHANGED|UNCHANGED)\]' "$W/a3.log"; then
  r "R6 fail a bare [UNCHANGED]-style label is still printed — it reads as a deploy verdict"
else
  r "R6 ok the artifact verdict is labelled 'plan:' and cannot be read as a deploy verdict"
fi

# =======================================================================================
# Part B — appbay-cli#5: a validator that cannot run does not return a verdict
# =======================================================================================
export APPBAY_HOME="$W/home-b"
appbay init --ingress-provider caddy $RUNTIME_FLAG >/dev/null 2>&1 || { r "SETUP fail init-b-failed"; exit 1; }
write_app "$APPBAY_HOME" 'traits:
  - type: ingress
    host: reportprobe.local
    port: 80
'

# The edge is deliberately not RUNNING. This is the state the issue was measured in — and
# stopping is reversible where removing was not (see EDGE_CTR above).
if [ -n "$EDGE_CTR" ]; then
  "$CBIN" stop "$EDGE_CTR" >/dev/null 2>&1
fi
appbay up "$APP" > "$W/b1.log" 2>&1
BLOG="$(cat "$W/b1.log")"

if echo "$BLOG" | grep -qi "configuration rejected"; then
  r "R7 fail still reports the configuration as REJECTED when Caddy was never asked"
else
  r "R7 ok does not claim the configuration was rejected"
fi

if echo "$BLOG" | grep -qiE "edge (container )?is not running|not running, so its configuration was never checked"; then
  r "R8 ok names the missing precondition (the edge is not running)"
else
  r "R8 fail does not name the missing edge container :: $(echo "$BLOG" | tail -3 | tr '\n' ' ')"
fi

if echo "$BLOG" | grep -q "appbay up caddy"; then
  r "R9 ok states the fix (\`appbay up caddy\`)"
else
  r "R9 fail does not tell the operator how to fix it"
fi

# The second half of #5: the app's container started anyway, and the summary called the
# whole thing a failure.
if [ "$(container_state)" = "running" ]; then
  if echo "$BLOG" | grep -qi "NOT reachable through the"; then
    r "R10 ok partial converge is reported as partial (container up, routes not installed)"
  else
    r "R10 fail container is running but the summary does not say the app is unreachable"
  fi
else
  r "R10 fail expected the app container to be running; state='$(container_state)'"
fi
PAYLOAD_EOF

multipass transfer "$PAYLOAD" "$VM:/tmp/deploy-reporting.sh" >/dev/null 2>&1 || {
  echo "  ❌ could not transfer the payload to $VM — is the VM running?"; exit 1; }
rm -f "$PAYLOAD"

OUT="$(vm 'bash /tmp/deploy-reporting.sh' 2>&1)"

while IFS= read -r line; do
  case "$line" in
    *" ok "*)   ok  "${line%% ok *}: $(echo "$line" | sed 's/^[^ ]* ok //')" ;;
    *" fail "*) bad "${line%% fail *}: $(echo "$line" | sed 's/^[^ ]* fail //')" ;;
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
