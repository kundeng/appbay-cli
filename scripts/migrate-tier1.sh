#!/usr/bin/env bash
# scripts/migrate-tier1.sh
# Tier 1 app migration: bare compose (no appbay.yaml)
#
# Deploys 3 stateless apps from docker-traefik sources into the running
# appbay-test VM to validate the bare-compose ingestion pipeline.
#
# Usage:
#   bash scripts/migrate-tier1.sh [--dry-run]

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
echo "  Tier 1 App Migration (bare compose)"
echo "============================================"
echo ""

# Verify VM is accessible
if ! multipass info "$VM" &>/dev/null; then
  echo "ERROR: VM '$VM' not accessible"
  exit 1
fi

# ---------------------------------------------------------------------------
# deploy_compose <name> <compose_yaml>
# Writes the compose file to the VM and runs appbay up.
# ---------------------------------------------------------------------------
deploy_compose() {
  local name="$1"
  local compose_yaml="$2"

  echo "  Deploying ${name}..."

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "    [dry-run] would create ~/.appbay/etc/apps/${name}/docker-compose.yml"
    pass "${name} (dry-run)"
    return
  fi

  # Base64-encode on host, decode on VM — avoids all shell quoting issues
  local encoded
  encoded=$(printf '%s' "$compose_yaml" | base64 -w 0)

  if ! multipass exec "$VM" -- bash -c "
    APP_DIR=\"\${APPBAY_HOME:-\$HOME/.appbay}/etc/apps/${name}\"
    mkdir -p \"\$APP_DIR\"
    printf '%s' '${encoded}' | base64 -d > \"\$APP_DIR/docker-compose.yml\"
    echo \"  wrote \$APP_DIR/docker-compose.yml\"
  "; then
    fail "${name}" "failed to write compose to VM"
    return
  fi

  local up_output
  if up_output=$(multipass exec "$VM" -- bash -c "appbay up ${name} 2>&1"); then
    echo "$up_output" | tail -5
    local running
    running=$(multipass exec "$VM" -- docker ps --filter "name=^/${name}$" --format "{{.Names}}" 2>/dev/null || echo "")
    if [[ "$running" == "$name" ]]; then
      pass "${name} (container running)"
    else
      local all
      all=$(multipass exec "$VM" -- docker ps -a --filter "name=^/${name}$" --format "{{.Names}} {{.Status}}" 2>/dev/null || echo "")
      fail "${name}" "up succeeded but container not running: ${all:-not found}"
    fi
  else
    echo "$up_output" | tail -10
    fail "${name}" "appbay up failed"
  fi

  echo ""
}

# ---------------------------------------------------------------------------
# Tier 1 app compose definitions
# ---------------------------------------------------------------------------

IT_TOOLS_COMPOSE='services:
  it-tools:
    image: corentinth/it-tools:latest
    container_name: it-tools
    restart: unless-stopped
    ports:
      - "8081:80"
    networks:
      - appbay_shared

networks:
  appbay_shared:
    external: true
'

ADMINER_COMPOSE='services:
  adminer:
    image: adminer:latest
    container_name: adminer
    restart: unless-stopped
    ports:
      - "8082:8080"
    networks:
      - appbay_shared

networks:
  appbay_shared:
    external: true
'

# Dozzle v10 uses direct socket mount (DOCKER_HOST env var removed in v10)
DOZZLE_COMPOSE='services:
  dozzle:
    image: amir20/dozzle:latest
    container_name: dozzle
    restart: unless-stopped
    ports:
      - "8083:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - appbay_shared

networks:
  appbay_shared:
    external: true
'

deploy_compose "it-tools" "$IT_TOOLS_COMPOSE"
deploy_compose "adminer"  "$ADMINER_COMPOSE"
deploy_compose "dozzle"   "$DOZZLE_COMPOSE"

# ---------------------------------------------------------------------------
# HTTP smoke test
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" == "false" ]]; then
  echo "  HTTP smoke tests:"
  declare -A PORT_MAP=( ["it-tools"]="8081" ["adminer"]="8082" ["dozzle"]="8083" )
  for app in it-tools adminer dozzle; do
    port="${PORT_MAP[$app]}"
    code=$(multipass exec "$VM" -- curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:${port}" 2>/dev/null || echo "000")
    if [[ "$code" == "200" || "$code" == "301" || "$code" == "302" ]]; then
      echo "    :${port} (${app}) → HTTP ${code} ✓"
    else
      echo "    :${port} (${app}) → HTTP ${code} ✗"
    fi
  done
  echo ""
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "============================================"
TOTAL=$((PASS + FAIL))
echo "  RESULT: ${PASS}/${TOTAL} deployed"
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
