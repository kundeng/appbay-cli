#!/usr/bin/env bash
# What happens to a service whose `environment:` is written as a MAP?
#
# Docker Compose accepts both `environment: [K=v]` and `environment: {K: v}`. Three places
# in the compiler touch that field and they do not agree about the second form:
#   compiler/compile.ts:1019      resolveMagicVars   — `if (!Array.isArray(...)) continue`
#   traits/definitions/scoped-env.ts:34 scoped-env   — `Array.isArray(...) ? ... : []`
#   traits/definitions/secrets.ts:56    secrets      — handles array, object and absent
#
# One app, one service, map-form environment carrying a pre-existing variable, a magic
# variable and a secret ref, with scoped-env and secrets both declared. The rendered
# compose shows which of the three did what.
set -uo pipefail

RUN_DIR=${AB_RUN:?set AB_RUN}
CLI=${AB_CLI:?set AB_CLI}
DATA="$RUN_DIR/data"
mkdir -p "$DATA"

home="$RUN_DIR/home"
rm -rf "$home"
mkdir -p "$home/etc/apps/mapform" "$home/etc/namespaces" "$home/var/lib/renders" "$home/var/lib/state"

cat > "$home/etc/system.yaml" <<YAML
home: $home
domain: lab.example.com
ingress_provider: caddy
YAML
cat > "$home/etc/namespaces/default.yaml" <<'YAML'
DOMAIN: lab.example.com
TEAM: platform
YAML

# `listform` and `mapform` are the SAME service twice, differing only in how
# `environment:` is spelled. Compose treats the two as equivalent.
cat > "$home/etc/apps/mapform/docker-compose.yml" <<'YAML'
services:
  listform:
    image: traefik/whoami:v1.10
    environment:
      - KEEP_ME=important
      - GEN_PASSWORD=${password:16}
  mapform:
    image: traefik/whoami:v1.10
    environment:
      KEEP_ME: important
      GEN_PASSWORD: ${password:16}
YAML

cat > "$home/etc/apps/mapform/appbay.yaml" <<'YAML'
name: mapform
services:
  listform:
    traits:
      - type: scoped-env
        vars:
          TEAM: "${{ns:TEAM}}"
      - type: secrets
        refs:
          API_TOKEN: vault://mapform/api_token
  mapform:
    traits:
      - type: scoped-env
        vars:
          TEAM: "${{ns:TEAM}}"
      - type: secrets
        refs:
          API_TOKEN: vault://mapform/api_token
YAML

APPBAY_HOME="$home" "$CLI" compile mapform > "$DATA/compile.stdout" 2> "$DATA/compile.stderr"
echo "compile exit=$?"
echo "--- stdout ---"; cat "$DATA/compile.stdout"
echo "--- stderr ---"; cat "$DATA/compile.stderr"
echo "--- rendered ---"
cp "$home/var/lib/renders/mapform/docker-compose.rendered.yml" "$DATA/rendered.yml" 2>/dev/null
cat "$DATA/rendered.yml" 2>/dev/null || echo "(none)"
echo "--- generated values store ---"
cp "$home/var/lib/state/generated-values.yaml" "$DATA/generated-values.yaml" 2>/dev/null
cat "$DATA/generated-values.yaml" 2>/dev/null || echo "(none)"
