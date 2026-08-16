#!/usr/bin/env bash
# scripts/migrate-tier2.sh
# Tier 2 app migration: ingress trait (Traefik dynamic config generation)
#
# Deploys ingress-enabled apps that exercise the ingress trait pipeline:
#   compose + appbay.yaml → compiled → Traefik dynamic config written
#
# Prerequisites:
#   - Traefik system app running (appbay up traefik)
#   - appbay_shared Docker network exists
#
# Usage:
#   bash scripts/migrate-tier2.sh [--dry-run]

set -euo pipefail

VM="${VM:-appbay-test}"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

PASS=0
FAIL=0
ERRORS=()

pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1: $2"; FAIL=$((FAIL+1)); ERRORS+=("$1: $2"); }

echo ""
echo "============================================"
echo "  Tier 2 App Migration (ingress trait)"
echo "============================================"
echo ""

# Verify VM is accessible
if ! multipass info "$VM" &>/dev/null; then
  echo "ERROR: VM '$VM' not accessible"
  exit 1
fi

# Verify Traefik is running
TRAEFIK_STATUS=$(multipass exec "$VM" -- docker ps --filter "name=appbay.traefik.traefik" --format "{{.Status}}" 2>/dev/null || echo "")
if [[ -z "$TRAEFIK_STATUS" ]]; then
  echo "WARNING: Traefik system app does not appear to be running."
  echo "         Run: appbay up traefik"
  echo "         Continuing anyway — ingress configs will be written but not served."
  echo ""
fi

# ---------------------------------------------------------------------------
# deploy_ingress <name> <compose_yaml> <appbay_yaml>
# ---------------------------------------------------------------------------
deploy_ingress() {
  local name="$1"
  local compose_yaml="$2"
  local appbay_yaml="$3"

  echo "  Deploying ${name}..."

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "    [dry-run] would create ~/.appbay/etc/apps/${name}/"
    pass "${name} (dry-run)"
    return
  fi

  local compose_enc appbay_enc
  compose_enc=$(printf '%s' "$compose_yaml" | base64 -w 0)
  appbay_enc=$(printf '%s' "$appbay_yaml" | base64 -w 0)

  if ! multipass exec "$VM" -- bash -c "
    APP_DIR=\"\${APPBAY_HOME:-\$HOME/.appbay}/etc/apps/${name}\"
    mkdir -p \"\$APP_DIR\"
    printf '%s' '${compose_enc}' | base64 -d > \"\$APP_DIR/docker-compose.yml\"
    printf '%s' '${appbay_enc}' | base64 -d > \"\$APP_DIR/appbay.yaml\"
    echo \"  wrote \$APP_DIR/{docker-compose.yml,appbay.yaml}\"
  "; then
    fail "${name}" "failed to write files to VM"
    return
  fi

  local up_output
  if up_output=$(multipass exec "$VM" -- bash -c "appbay up ${name} 2>&1"); then
    echo "$up_output" | tail -5
    # Check container is running
    local running
    running=$(multipass exec "$VM" -- docker ps --filter "name=appbay\.${name}\." --format "{{.Names}}" 2>/dev/null | head -1 || echo "")
    if [[ -n "$running" ]]; then
      pass "${name} (container running: ${running})"
    else
      # Try without the appbay. prefix (bare compose apps)
      running=$(multipass exec "$VM" -- docker ps --filter "name=${name}" --format "{{.Names}}" 2>/dev/null | head -1 || echo "")
      if [[ -n "$running" ]]; then
        pass "${name} (container running: ${running})"
      else
        fail "${name}" "up succeeded but no container running"
      fi
    fi

    # Check that Traefik dynamic config was written
    local dyn_config
    dyn_config="\${APPBAY_HOME:-\$HOME/.appbay}/etc/apps/traefik/config/dynamic/${name}.yml"
    if multipass exec "$VM" -- bash -c "test -f '${dyn_config//\\/}' 2>/dev/null" 2>/dev/null; then
      pass "${name} (traefik config written)"
    else
      local dyn_path
      dyn_path=$(multipass exec "$VM" -- bash -c "echo \"\${APPBAY_HOME:-\$HOME/.appbay}/etc/apps/traefik/config/dynamic/${name}.yml\"")
      if multipass exec "$VM" -- test -f "$dyn_path" 2>/dev/null; then
        pass "${name} (traefik config written)"
      else
        fail "${name}" "traefik dynamic config not found at etc/apps/traefik/config/dynamic/${name}.yml"
      fi
    fi
  else
    echo "$up_output" | tail -10
    fail "${name}" "appbay up failed"
  fi

  echo ""
}

# ---------------------------------------------------------------------------
# Tier 2 app definitions
# ---------------------------------------------------------------------------

UPTIME_KUMA_COMPOSE='services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    volumes:
      - data:/app/data
    networks:
      - appbay_shared

volumes:
  data:

networks:
  appbay_shared:
    external: true
'

UPTIME_KUMA_APPBAY='project: homelab
environment: production

traits:
  - type: ingress
    service: uptime-kuma
    host: uptime.local
    port: 3001
    exposure: internal
'

GLANCES_COMPOSE='services:
  glances:
    image: nicolargo/glances:latest-full
    restart: unless-stopped
    pid: host
    environment:
      - GLANCES_OPT=-w
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - appbay_shared

networks:
  appbay_shared:
    external: true
'

GLANCES_APPBAY='project: homelab
environment: production

traits:
  - type: ingress
    service: glances
    host: glances.local
    port: 61208
    exposure: internal
'

deploy_ingress "uptime-kuma" "$UPTIME_KUMA_COMPOSE" "$UPTIME_KUMA_APPBAY"
deploy_ingress "glances"     "$GLANCES_COMPOSE"     "$GLANCES_APPBAY"

# ---------------------------------------------------------------------------
# Traefik config validation
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" == "false" ]]; then
  echo "  Traefik dynamic config inventory:"
  multipass exec "$VM" -- bash -c "
    DYN=\${APPBAY_HOME:-\$HOME/.appbay}/etc/apps/traefik/config/dynamic
    for f in \$DYN/*.yml; do
      echo \"    \$(basename \$f)\"
    done
  " 2>/dev/null || true
  echo ""
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "============================================"
TOTAL=$((PASS + FAIL))
echo "  RESULT: ${PASS}/${TOTAL} checks passed"
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo ""
  echo "  Failures:"
  for e in "${ERRORS[@]}"; do
    echo "    ✗ $e"
  done
fi
echo "============================================"
echo ""

[[ $FAIL -eq 0 ]]
