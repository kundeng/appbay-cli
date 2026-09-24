#!/usr/bin/env bash
# Does an app whose `auth` trait FAILED to compile still get deployed — and routed?
#
# probe-04 showed that on the code default (ingress_provider: traefik) the auth trait
# errors, yet `appbay compile` still reports "1 compiled" and writes the rendered compose
# and the Traefik route. The question that matters is what `appbay up` does next: refuse,
# or bring the app up publicly routed with no authorization policy.
#
# STATE CHANGE, LOCAL AND REVERSIBLE. Creates the external network `appbay_shared` and
# starts one traefik/whoami container in a scratch APPBAY_HOME. Both are removed at the
# end of this script and again by the trap on any exit path. Rollback if it is ever left
# behind:  docker compose -p authgap down -v ; docker network rm appbay_shared
set -uo pipefail

RUN_DIR=${AB_RUN:?set AB_RUN}
CLI=${AB_CLI:?set AB_CLI}
DATA="$RUN_DIR/data"
mkdir -p "$DATA"
home="$RUN_DIR/home"

cleanup() {
  echo "--- teardown ---"
  docker compose -p authgap -f "$home/var/lib/renders/authgap/docker-compose.rendered.yml" down -v 2>&1 | sed 's/^/  /' || true
  docker rm -f appbay.authgap.web 2>&1 | sed 's/^/  /' || true
  docker network rm appbay_shared 2>&1 | sed 's/^/  /' || true
}
trap cleanup EXIT

rm -rf "$home"
mkdir -p "$home/etc/apps/authgap" "$home/etc/namespaces" "$home/var/lib/renders" "$home/var/lib/state"
cat > "$home/etc/system.yaml" <<YAML
home: $home
domain: lab.example.com
YAML
# No ingress_provider key: this is the DEFAULT install, so DEFAULT_INGRESS_PROVIDER
# (schemas/instance.ts:72 = "traefik") applies — exactly what `appbay init` leaves behind
# unless --ingress-provider caddy was passed.
cat > "$home/etc/namespaces/default.yaml" <<'YAML'
DOMAIN: lab.example.com
YAML
cat > "$home/etc/apps/authgap/docker-compose.yml" <<'YAML'
services:
  web:
    image: traefik/whoami:v1.10
YAML
cat > "$home/etc/apps/authgap/appbay.yaml" <<'YAML'
name: authgap
traits:
  - type: auth
    policy: authenticated
services:
  web:
    traits:
      - type: ingress
        port: 80
        exposure: both
YAML

echo "===== the operator asked for authenticated access. What does up do? ====="
docker network create appbay_shared >/dev/null 2>&1 || true
APPBAY_HOME="$home" "$CLI" up authgap > "$DATA/up.stdout" 2> "$DATA/up.stderr"
echo "appbay up exit=$?"
echo "--- stdout ---"; cat "$DATA/up.stdout"
echo "--- stderr ---"; cat "$DATA/up.stderr"

echo
echo "===== is the container running? ====="
docker ps --filter 'label=com.appbay.app=authgap' --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | tee "$DATA/running.txt"
echo "(a name above means the app is up)"

echo
echo "===== was any authorization policy written? ====="
find "$home" -name '*.caddy' -o -path '*security/policies*' -type f 2>/dev/null | tee "$DATA/policies.txt"
echo "(empty means the app is deployed with NO authorization policy)"
echo "route files that WERE written:"
find "$home/var/lib/renders" -path '*config/dynamic*' -type f 2>/dev/null | sed "s|$home/||" | tee "$DATA/routes.txt"
find "$home/etc/apps/traefik" -type f 2>/dev/null | sed "s|$home/||" | tee -a "$DATA/routes.txt"
