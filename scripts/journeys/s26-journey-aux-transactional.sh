#!/usr/bin/env bash
# S26 / issue #60 journey 8 — generated auxiliary artifacts install transactionally.
#
# ⭐ THE EDGE IS THE ONLY PATH TO EVERY DEPLOYED APP, so a half-installed route fragment is
# not a cosmetic problem: an invalid file left in the edge's config directory can stop the
# whole proxy from loading, taking down apps that had nothing to do with the failed deploy.
# "Transactional" here means a rejected deploy leaves the edge exactly as it found it.
#
# 🚨 THE ASSERTION THAT MATTERS IS THE BYSTANDER. Checking that the failed app's own file is
# gone is easy; the real property is that an UNRELATED, already-working app is untouched and
# still served. A rollback that removes too much is as bad as one that removes too little.
#
# Self-provisioning; removes both apps.
#   VM=appbay-docker ./s26-journey-aux-transactional.sh
#   VM=appbay-rhel PRIV=sudo CBIN=podman ./s26-journey-aux-transactional.sh

set -uo pipefail
VM="${VM:-appbay-docker}"
PRIV="${PRIV:-env}"
HOME_DIR="${HOME_DIR:-/home/ubuntu/.appbay}"
CBIN="${CBIN:-docker}"
GOOD="txgood"
BAD="txbad"
DYN="$HOME_DIR/etc/apps/caddy/config/dynamic"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }
ab()  { vm "cd /home/ubuntu && appbay $1 2>&1"; }

app() { # $1 name, $2 host
  vm "mkdir -p $HOME_DIR/etc/apps/$1" >/dev/null 2>&1
  vm "cat > $HOME_DIR/etc/apps/$1/docker-compose.yml <<'EOF'
services:
  app:
    image: docker.io/library/busybox:latest
    command: [\"sleep\", \"600\"]
EOF" >/dev/null 2>&1
  vm "cat > $HOME_DIR/etc/apps/$1/appbay.yaml <<EOF
project: default
environment: default
upstream:
  source: ./docker-compose.yml
  expose:
    - app
traits:
  - type: ingress
    host: \"$2\"
    port: 80
    service: app
    exposure: internal
EOF" >/dev/null 2>&1
}

cleanup() {
  for a in "$GOOD" "$BAD"; do
    ab "down $a" >/dev/null 2>&1
    vm "rm -rf $HOME_DIR/etc/apps/$a $HOME_DIR/var/lib/renders/$a $DYN/$a.caddy $DYN/auth/$a-*.caddy" >/dev/null 2>&1
  done
}
trap cleanup EXIT
cleanup

echo "── Install a good app: its artifact must appear"
app "$GOOD" "txgood.test.local"
ab "up $GOOD" >/dev/null 2>&1
vm "test -f $DYN/$GOOD.caddy" >/dev/null 2>&1 && ok "the good app's edge artifact is installed" \
                                              || { bad "the good app produced no artifact; the rest would be vacuous"; exit 1; }
GOOD_SHA=$(vm "sha256sum $DYN/$GOOD.caddy | cut -d' ' -f1" | tr -d '[:space:]')
EDGE_BEFORE=$(vm "$CBIN inspect appbay.caddy.caddy --format '{{.State.StartedAt}}' 2>/dev/null || echo none" | tr -d '[:space:]')

echo "── Deploy an app whose edge config the proxy will REJECT"
# An unbalanced brace cannot survive Caddy's adapter, so the whole config is refused.
app "$BAD" "bad{brace.test.local"
OUT=$(ab "up $BAD")
echo "$OUT" | grep -qE "[1-9][0-9]* error\(s\)" && ok "the deploy reported an error rather than success" \
                                                || { bad "🚨 a config the proxy rejects was reported as a successful deploy"; echo "$OUT" | tail -3 | sed 's/^/       /'; }

vm "test -f $DYN/$BAD.caddy" >/dev/null 2>&1 && bad "🚨 the rejected app's artifact was LEFT BEHIND in the edge config" \
                                             || ok "the rejected app's artifact was rolled back"

echo "── The bystander must be untouched"
# 🚨 This is the property. A rollback that reverts more than it installed would silently
# break an unrelated app that was serving fine a moment ago.
GOOD_AFTER=$(vm "sha256sum $DYN/$GOOD.caddy 2>/dev/null | cut -d' ' -f1" | tr -d '[:space:]')
[ "$GOOD_SHA" = "$GOOD_AFTER" ] && [ -n "$GOOD_AFTER" ] && ok "the unrelated app's artifact is byte-identical" \
                                                        || bad "🚨 the unrelated app's artifact changed or vanished ($GOOD_SHA -> $GOOD_AFTER)"

echo "── The edge itself must still be healthy"
EDGE_STATE=$(vm "$CBIN inspect appbay.caddy.caddy --format '{{.State.Status}}' 2>/dev/null || echo absent" | tr -d '[:space:]')
[ "$EDGE_STATE" = "running" ] && ok "edge still running" || bad "🚨 the edge is $EDGE_STATE after a rejected deploy"
EDGE_AFTER=$(vm "$CBIN inspect appbay.caddy.caddy --format '{{.State.StartedAt}}' 2>/dev/null || echo none" | tr -d '[:space:]')
# A rejected deploy should never have restarted the proxy — validation happens before reload.
[ "$EDGE_BEFORE" = "$EDGE_AFTER" ] && ok "edge was not restarted by the failed deploy" \
                                   || bad "the edge restarted during a deploy that failed validation"

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
