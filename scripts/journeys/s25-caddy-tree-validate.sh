#!/usr/bin/env bash
# S25 task 13 — validate the WHOLE assembled Caddy tree before it reaches a live edge.
#
# 🚨 WHY BEFORE INSTALL. Caddy Security has no last-good-config fallback the way Caddy's
# own reload does for some errors: a config that fails to provision takes the edge down,
# and the edge is the only path to every deployed app. Validate a candidate tree in a
# staging copy, then swap.
#
# Usage:  TREE=/path/to/candidate ./s25-caddy-tree-validate.sh
#         IMAGE=appbay/caddy-security:test RUNNER=podman ./s25-caddy-tree-validate.sh
#
# TREE must be laid out exactly as the edge mounts it:
#   Caddyfile
#   global/*.caddy                 optional ACME
#   security/users.json            local identity store
#   security/policies/*.caddy      authorization policies (auth trait)
#   dynamic/*.caddy                per-app site blocks (ingress trait)
#   dynamic/auth/*.caddy           per-app auth fragments (auth trait)

set -uo pipefail
TREE="${TREE:?TREE must point at the candidate config tree}"
IMAGE="${IMAGE:-appbay/caddy-security:test}"
RUNNER="${RUNNER:-docker}"
[ "$RUNNER" = "podman" ] && RUNNER="sudo podman"
SECRET="${APPBAY_EDGE_TOKEN_SECRET:-validation-only-not-a-real-secret}"

echo "── validating $TREE against $IMAGE ──"

# ⚠️ MOUNT READ-WRITE. Caddy Security initialises its identity database on provision and
# a :ro mount fails with "failed database commit ... read-only file system" — which reads
# like a config error and is not one. Validate against a COPY so this cannot touch the
# live tree.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -a "$TREE/." "$work/"

out=$($RUNNER run --rm \
  -e APPBAY_EDGE_TOKEN_SECRET="$SECRET" \
  -v "$work:/etc/caddy" \
  "$IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)
rc=$?

if [ $rc -eq 0 ] && grep -q "Valid configuration" <<<"$out"; then
  echo "  ✅ Valid configuration"
  exit 0
fi

echo "  ❌ INVALID — the edge would fail to start. Not installing."
# Surface the adapter/provision line, which is the one that names the real problem;
# the rest is TLS-cache and shutdown noise.
grep -iE "^Error:|unrecognized|wrong argument|failed provisioning|not defined|ambiguous" <<<"$out" | head -5 | sed 's/^/     /'
exit 1
