#!/usr/bin/env bash
# Does AppBay compile deployment concerns into a Compose file the developer did NOT tailor?
#
# Builds a throwaway APPBAY_HOME holding one app whose docker-compose.yml is a stock
# upstream file — host ports published, no networks, no labels, nothing appbay-specific —
# and a sidecar appbay.yaml declaring ingress, auth, scoped-env and secrets. Compiles it
# once per ingress provider and keeps every artifact.
#
# Answers, per provider: what the rendered compose became, which auxiliary files appeared,
# and whether the compile succeeded.
set -uo pipefail

RUN_DIR=${AB_RUN:?set AB_RUN}
CLI=${AB_CLI:?set AB_CLI}
DATA="$RUN_DIR/data"
mkdir -p "$DATA"

make_home() {
  local home=$1 provider=$2
  rm -rf "$home"
  mkdir -p "$home/etc/apps/demo" "$home/etc/namespaces" "$home/var/lib/renders" "$home/var/lib/state"

  cat > "$home/etc/system.yaml" <<YAML
home: $home
project: eval
domain: lab.example.com
ingress_provider: $provider
YAML

  cat > "$home/etc/namespaces/default.yaml" <<'YAML'
DOMAIN: lab.example.com
TEAM: platform
YAML

  # A STOCK upstream compose file. Nothing here knows appbay exists: it publishes a host
  # port, names no networks, carries no labels, and sets a password from the environment.
  cat > "$home/etc/apps/demo/docker-compose.yml" <<'YAML'
services:
  web:
    image: traefik/whoami:v1.10
    ports:
      - "8080:80"
    environment:
      - WHOAMI_NAME=demo
      - ADMIN_PASSWORD=${password:24}
    restart: unless-stopped
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: ${password:32}
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  dbdata:
YAML

  # The deployment concerns, declared once, beside the compose file.
  cat > "$home/etc/apps/demo/appbay.yaml" <<'YAML'
name: demo
namespace: default
traits:
  - type: auth
    policy: authenticated
services:
  web:
    traits:
      - type: ingress
        port: 80
        exposure: both
      - type: scoped-env
        vars:
          TEAM: "${{ns:TEAM}}"
      - type: secrets
        refs:
          API_TOKEN: vault://demo/api_token
        injection: runtime-env
YAML
}

for provider in traefik caddy; do
  home="$RUN_DIR/home-$provider"
  make_home "$home" "$provider"
  echo "===== provider=$provider ====="
  APPBAY_HOME="$home" "$CLI" compile demo > "$DATA/compile-$provider.stdout" 2> "$DATA/compile-$provider.stderr"
  echo "exit=$?"
  cat "$DATA/compile-$provider.stdout"
  echo "--- stderr ---"
  cat "$DATA/compile-$provider.stderr"
  echo "--- rendered compose ---"
  if [ -f "$home/var/lib/renders/demo/docker-compose.rendered.yml" ]; then
    cp "$home/var/lib/renders/demo/docker-compose.rendered.yml" "$DATA/rendered-$provider.yml"
    cat "$DATA/rendered-$provider.yml"
  else
    echo "(no rendered compose)"
  fi
  echo "--- auxiliary files under the render dir ---"
  find "$home/var/lib/renders/demo" -type f | sed "s|$home/var/lib/renders/demo/||" | sort
  for f in $(find "$home/var/lib/renders/demo/etc" -type f 2>/dev/null | sort); do
    echo "----- ${f#"$home/var/lib/renders/demo/"} -----"
    cat "$f"
  done
  echo
done

# The developer's compose file must be untouched by the compile.
echo "===== was the input compose modified? ====="
for provider in traefik caddy; do
  sha=$(shasum -a 256 "$RUN_DIR/home-$provider/etc/apps/demo/docker-compose.yml" | cut -d' ' -f1)
  echo "$provider input sha256=$sha"
done
