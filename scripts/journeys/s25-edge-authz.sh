#!/usr/bin/env bash
# S25 — prove the Caddy Security edge enforces group-based authorization.
#
# 🚨 THE ONLY TEST THAT CAN SEE THIS CLASS OF DEFECT IS THE NEGATIVE ONE. A member is
# admitted whether the policy matches or falls through to something permissive, so a
# passing positive case proves nothing. This journey checks BOTH: a member reaches the app
# AND a non-member is refused. Both users must authenticate successfully first — two users
# failing identically is a broken edge, not a deny result.
#
# Requires a browser: Caddy Security's portal is a two-stage form (username+realm, then
# password) and cannot be driven with curl. Uses agent-browser.
#
# Usage:
#   VM=appbay-docker HOST=whoami.test.local \
#   MEMBER=alice MEMBER_PW=... OUTSIDER=bob OUTSIDER_PW=... \
#   ./s25-edge-authz.sh
#
# The VM must already have the caddy edge deployed. Everything else — the gated app, the
# member and the outsider — is provisioned by this journey and removed afterwards.

set -uo pipefail
VM="${VM:-appbay-docker}"
# ⚠️ The container CLI is a parameter. This script predates the runtime matrix; hardcoding
# `docker` made every container call print "docker: command not found" on the Podman host —
# and in a before/after journey that silently produced PASSES (see
# s25-interface-optionality.sh and rule 2 in README.md).
CBIN="${CBIN:-docker}"
# Rootful installs need a privilege prefix. `env` is a deliberate no-op: an empty variable
# collapses to a zero-length argv element and breaks the exec.
PRIV="${PRIV:-env}"

# ⭐ THE GATED APP IS PROVISIONED TOO, NOT ASSUMED. This journey's header used to require
# "an app with an auth trait declaring `group:`" — and the SHIPPED whoami has no auth trait,
# so that app existed only because someone had hand-edited a manifest on one VM. A journey
# that needs a hand-prepared host is the exact trap tests/bdd/ fell into for months.
# Provisioned below unless HOST is passed explicitly.
APP="${APP:-authzapp}"
HOST="${HOST:-}"
PROVISIONED_APP=no
# 🚨 THE SOCKS PORT IS PER-VM. It used to default to :1080 for every target and REUSE any
# tunnel already listening there — so running this against the Podman host while a tunnel to
# the Docker host was still up silently routed the browser to the WRONG MACHINE, and the
# journey reported "site can't be reached" as though the edge were down. A cached tunnel to
# the wrong host is indistinguishable from a broken app.
SOCKS_PORT="${SOCKS_PORT:-$(( 1080 + $(printf '%s' "$VM" | cksum | cut -d" " -f1) % 100 ))}"
SOCKS="${SOCKS:-127.0.0.1:$SOCKS_PORT}"

# ⭐ SELF-PROVISIONING BY DEFAULT. This journey used to REQUIRE four credentials to be
# passed in, which meant it could only be re-run by whoever still had the passwords from
# the session that created them. A journey that cannot be re-run is not evidence — it is a
# memory of evidence, and the deny-by-group claim was resting on exactly that.
#
# It now creates its own member and outsider, with known passwords, and removes them
# afterwards. Pass MEMBER/MEMBER_PW/OUTSIDER/OUTSIDER_PW to use existing accounts instead.
MEMBER="${MEMBER:-authz-member}"
OUTSIDER="${OUTSIDER:-authz-outsider}"
MEMBER_PW="${MEMBER_PW:-}"
OUTSIDER_PW="${OUTSIDER_PW:-}"
GROUP="${GROUP:-admins}"
PROVISIONED=no

ab() { multipass exec "$VM" -- $PRIV bash -c "cd /home/ubuntu && appbay $1 2>&1"; }
vmsh() { multipass exec "$VM" -- $PRIV bash -c "$1"; }

if [ -z "$HOST" ]; then
  DOMAIN=$(vmsh "grep -m1 '^domain:' /home/ubuntu/.appbay/project.yaml | awk '{print \$2}'" | tr -d '[:space:]')
  [ -n "$DOMAIN" ] || { echo "  ❌ could not read domain from project.yaml"; exit 1; }
  HOST="$APP.$DOMAIN"
  vmsh "mkdir -p /home/ubuntu/.appbay/etc/apps/$APP" >/dev/null 2>&1
  vmsh "cat > /home/ubuntu/.appbay/etc/apps/$APP/docker-compose.yml <<'EOF'
services:
  app:
    image: docker.io/traefik/whoami:latest
EOF" >/dev/null 2>&1
  vmsh "cat > /home/ubuntu/.appbay/etc/apps/$APP/appbay.yaml <<EOF
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
    group: $GROUP
EOF" >/dev/null 2>&1
  ab "up $APP" >/dev/null 2>&1
  PROVISIONED_APP=yes
fi

if [ -z "$MEMBER_PW" ] || [ -z "$OUTSIDER_PW" ]; then
  # ⚠️ Fixed, obviously-disposable passwords rather than generated ones: the browser has to
  # type them, and a generated secret would have to be captured out of command output — one
  # more place for a credential to end up in a log.
  MEMBER_PW="AuthzMember-journey-1"
  OUTSIDER_PW="AuthzOutsider-journey-1"
  ab "edge users create $MEMBER --email $MEMBER@example.invalid --roles $GROUP --password-stdin <<<'$MEMBER_PW'" >/dev/null 2>&1
  ab "edge users create $OUTSIDER --email $OUTSIDER@example.invalid --roles users --password-stdin <<<'$OUTSIDER_PW'" >/dev/null 2>&1
  PROVISIONED=yes
fi

cleanup_users() {
  if [ "$PROVISIONED_APP" = "yes" ]; then
    ab "down $APP" >/dev/null 2>&1
    vmsh "rm -rf /home/ubuntu/.appbay/etc/apps/$APP /home/ubuntu/.appbay/var/lib/renders/$APP /home/ubuntu/.appbay/etc/apps/caddy/config/dynamic/$APP.caddy /home/ubuntu/.appbay/etc/apps/caddy/config/dynamic/auth/$APP-*.caddy /home/ubuntu/.appbay/etc/apps/caddy/config/security/policies/$APP.caddy" >/dev/null 2>&1
  fi
  [ "$PROVISIONED" = "yes" ] || return 0
  multipass exec "$VM" -- $PRIV bash -c "python3 - <<'PYEOF'
import json, os
p = '/home/ubuntu/.appbay/etc/apps/caddy/config/security/users.json'
if os.path.exists(p):
    d = json.load(open(p))
    d['users'] = [u for u in d.get('users', []) if u.get('username') not in ('$MEMBER', '$OUTSIDER')]
    json.dump(d, open(p, 'w'), indent=2)
PYEOF" >/dev/null 2>&1
}
trap cleanup_users EXIT

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

# ⚠️ The browser must resolve HOST to the VM. Map it INSIDE the VM and tunnel, rather than
# editing the workstation's /etc/hosts — a test must not require modifying the machine
# running it.
multipass exec "$VM" -- bash -c \
  "grep -q '$HOST' /etc/hosts || echo '127.0.0.1 $HOST' | sudo tee -a /etc/hosts >/dev/null"
IP=$(multipass info "$VM" --format json | python3 -c "import json,sys;print(json.load(sys.stdin)['info']['$VM']['ipv4'][0])")

# ⚠️ Verify the tunnel actually reaches THIS VM before reusing it — a listening port is not
# proof of the right destination.
if ! ss -tln 2>/dev/null | grep -q ":${SOCKS##*:}"; then
  sudo ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes \
    -i /var/snap/multipass/common/data/multipassd/ssh-keys/id_rsa \
    -N -D "$SOCKS" "ubuntu@$IP" >/dev/null 2>&1 &
  sleep 5
fi

# ⚠️ RESTART THE EDGE FIRST. Authorization policies are imported inside the GLOBAL block and
# Caddy's --watch does NOT reload those (routes and auth fragments, yes; policies, no). A
# stale policy once looked exactly like broken role matching in caddy-security.
multipass exec "$VM" -- $PRIV $CBIN restart appbay.caddy.caddy >/dev/null 2>&1
sleep 7

# Log in through the real two-stage portal and report what the app returns.
attempt() {
  local user="$1" pw="$2" sess="$3"
  local AB="agent-browser --session $sess --proxy socks5://$SOCKS --ignore-https-errors"
  $AB open "https://$HOST/auth/login" >/dev/null 2>&1
  $AB snapshot -i >/dev/null 2>&1
  $AB fill @e4 "$user" >/dev/null 2>&1; $AB click @e3 >/dev/null 2>&1; sleep 3
  $AB snapshot -i >/dev/null 2>&1
  $AB fill @e4 "$pw"   >/dev/null 2>&1; $AB click @e3 >/dev/null 2>&1; sleep 3
  local landed; landed=$($AB eval "location.href" 2>/dev/null | tr -d '"')
  $AB open "https://$HOST/" >/dev/null 2>&1; sleep 2
  local body; body=$($AB eval "document.body.innerText.slice(0,80)" 2>/dev/null)
  echo "$landed|$body"
}

echo "── member: $MEMBER (holds the required group) ──"
IFS='|' read -r m_landed m_body <<<"$(attempt "$MEMBER" "$MEMBER_PW" "member")"
case "$m_landed" in
  */auth/portal*) ok "$MEMBER authenticated (reached /auth/portal)" ;;
  */sandbox/*)    bad "$MEMBER parked in /auth/sandbox — no token issued; check the portal's transform user block (#68)" ;;
  *)              bad "$MEMBER did not authenticate (landed $m_landed)" ;;
esac
if grep -q "Hostname" <<<"$m_body"; then ok "$MEMBER REACHES the app"; else bad "$MEMBER was refused — a member must be admitted, else the deny below proves nothing"; fi

echo "── outsider: $OUTSIDER (authenticates, lacks the group) ──"
IFS='|' read -r o_landed o_body <<<"$(attempt "$OUTSIDER" "$OUTSIDER_PW" "outsider")"
case "$o_landed" in
  */auth/portal*) ok "$OUTSIDER authenticated (reached /auth/portal)" ;;
  *)              bad "$OUTSIDER did not authenticate (landed $o_landed) — cannot test authorization" ;;
esac
if grep -qi "Forbidden" <<<"$o_body"; then ok "$OUTSIDER is DENIED (Forbidden)"
elif grep -q "Hostname" <<<"$o_body"; then bad "🚨 $OUTSIDER REACHED THE APP — the group restriction is inert"
else bad "$OUTSIDER got an unexpected response: $o_body"; fi

agent-browser close --all >/dev/null 2>&1
echo
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
