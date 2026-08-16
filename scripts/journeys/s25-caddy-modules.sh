#!/usr/bin/env bash
# S25 task 11 — assert the Caddy Security module inventory.
#
# The Caddyfile directive surface is module-version-sensitive: a missing module does not
# fail the build, it fails at config-parse time on a directive nobody thought to test.
# This asserts the modules the ingress and auth traits actually emit directives for.
#
# Usage:  IMAGE=appbay/caddy-security:test ./s25-caddy-modules.sh
#         RUNNER=podman ./s25-caddy-modules.sh      # rootful podman host

set -uo pipefail
IMAGE="${IMAGE:-appbay/caddy-security:test}"
RUNNER="${RUNNER:-docker}"
[ "$RUNNER" = "podman" ] && RUNNER="sudo podman"

# Pins that must match system-apps/caddy/config/Dockerfile.cloudflare.
EXPECT_CADDY="${EXPECT_CADDY:-v2.11.4}"

REQUIRED=(
  "security"                                   # caddy-security app module
  "http.handlers.authenticator"                # auth portal handler
  "http.authentication.providers.authorizer"   # authorize directive
  "dns.providers.cloudflare"                   # DNS-01 for the ACME path
)

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

# ⚠️ ABSENT AND BROKEN ARE DIFFERENT ANSWERS. This journey runs LOCALLY and ignores $VM, so
# pointing it at a VM leaves it inspecting your workstation. Without this guard it reported
# "caddy version — expected v2.11.4, got '<none>'" and "image unusable" for an image that was
# merely not present here, which reads as a product defect.
if ! $RUNNER image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "── image: $IMAGE (runner: $RUNNER) ──"
  echo "  ⏭ not present on THIS machine. This journey is local and does not read \$VM;"
  echo "     build or pull the image here, or set IMAGE=<tag> to one you have:"
  $RUNNER images --format '       {{.Repository}}:{{.Tag}}' 2>/dev/null | grep -i caddy | head -4
  exit 2
fi

echo "── image: $IMAGE (runner: $RUNNER) ──"

version=$($RUNNER run --rm "$IMAGE" caddy version 2>/dev/null | awk '{print $1}')
if [ "$version" = "$EXPECT_CADDY" ]; then ok "caddy version $version matches the pin"
else bad "caddy version — expected $EXPECT_CADDY, got '${version:-<none>}'"; fi

modules=$($RUNNER run --rm "$IMAGE" caddy list-modules 2>/dev/null)
if [ -z "$modules" ]; then
  bad "caddy list-modules returned nothing — image unusable"
  echo; echo "════ $pass passed, $fail failed ════"; exit 1
fi

for m in "${REQUIRED[@]}"; do
  if grep -qx "$m" <<<"$modules"; then ok "module present: $m"
  else bad "module MISSING: $m"; fi
done

echo "  ℹ $(grep -c . <<<"$modules") modules total"
echo
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
