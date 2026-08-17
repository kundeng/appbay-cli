#!/usr/bin/env bash
# S26 — no tRPC response carries a plaintext secret the UI does not render.
#
# ⭐ WHY THIS EXISTS SEPARATELY FROM s26-journey-secrets-never-leak.sh. That journey checks
# CLI output, rendered artifacts, plans, logs and the filesystem — everything except the
# WEB API. And the web API is where a leak actually happened: `secrets.scan` returned the
# plaintext `value` of every scanned variable, which the scan table never draws. The values
# sat in the tRPC payload, React state, devtools and any HAR capture.
#
# 🚨 A PAYLOAD IS NOT A SCREEN. "The UI does not display it" is not a security property —
# anything in the response is on the client. This journey greps the RESPONSE BODIES, not the
# rendered page.
#
# Runs locally (needs the repo and pnpm), against a throwaway install on its own port.
#   ./s26-journey-web-api-secrets.sh

set -uo pipefail
# 🚨 DERIVED FROM THIS SCRIPT'S OWN LOCATION, never a hardcoded checkout path. This read
# `$HOME/src/appbay` until 2026-08-16 — a directory that stopped existing when the three
# scattered checkout roots were consolidated into ~/Projects on 2026-08-15. The journey then
# ran `$REPO/apps/cli/dist/appbay init` against a path with no binary, swallowed the error
# with `>/dev/null 2>&1`, and reported "init did not scaffold" — blaming the product for a
# missing directory. All three local-only journeys had the same line, and because the sweep
# runner SKIPS local-only scripts, none of them had been run since the move.
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PORT="${PORT:-3777}"
SCRATCH="${SCRATCH:-/tmp/appbay-webleak-journey}"
H="$SCRATCH/home"
SENTINEL="WEBAPI-SENTINEL-NEVER-SHIP-7k4"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

# 🚨 THIS JOURNEY RUNS ON THE WORKSTATION, so it must leave no trace on it.
# `appbay init --dir X` PERSISTS X to ~/.config/appbay/home — a machine-wide
# default every later appbay command reads. Passing $H there repoints the
# developer's own CLI at $SCRATCH, which the trap below deletes on exit. Use
# APPBAY_HOME instead: init honours it as a runtime override and does not save
# it. See s26-journey-doctor-parity.sh for the incident this prevents.
WS_POINTER="$HOME/.config/appbay/home"
ws_pointer() { if [ -f "$WS_POINTER" ]; then cat "$WS_POINTER"; else echo "<unset>"; fi; }
WS_BEFORE="$(ws_pointer)"

cleanup() {
  for p in $(ss -lptn "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u); do kill "$p" 2>/dev/null || true; done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
cleanup
mkdir -p "$H"

# tRPC query helper. APPBAY_DEV_AUTH lets the journey reach protected procedures without
# driving a browser login — this journey is about response CONTENT, not about auth, which
# s26-journey-first-run-auth.sh covers.
trpc() {
  curl -s --max-time 15 \
    "http://localhost:$PORT/api/trpc/$1?batch=1&input=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$2")"
}

echo "── Stage an install whose app has a plaintext secret in its compose"
APPBAY_HOME="$H" "$REPO/apps/cli/dist/appbay" init --domain leak.test.local --project leak >/dev/null 2>&1
[ "$(ws_pointer)" = "$WS_BEFORE" ] \
  && ok "workstation APPBAY_HOME pointer untouched" \
  || bad "🚨 this journey repointed the workstation: $WS_BEFORE -> $(ws_pointer)"
mkdir -p "$H/etc/apps/leaky"
cat > "$H/etc/apps/leaky/docker-compose.yml" <<EOF
services:
  app:
    image: docker.io/library/busybox:latest
    environment:
      DB_PASSWORD: $SENTINEL
      API_TOKEN: $SENTINEL
EOF
cat > "$H/etc/apps/leaky/appbay.yaml" <<'EOF'
project: default
environment: default
upstream:
  source: ./docker-compose.yml
  expose:
    - app
EOF

( cd "$REPO" && APPBAY_HOME="$H" APPBAY_DEV_AUTH=true PORT="$PORT" pnpm --filter @appbay/web dev >"$SCRATCH/web.log" 2>&1 & )
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" 2>/dev/null)" = "200" ] && break
  sleep 2
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" 2>/dev/null)" = "200" ] \
  && ok "server up on :$PORT" || { bad "server did not start"; exit 1; }

# ⚠️ A CONTROL FIRST. If the endpoints return nothing at all, every "no sentinel" result
# below is vacuously true — the same trap as comparing two broken states.
SCAN=$(trpc "secrets.scan" '{"0":{"json":{"appName":"leaky"}}}')
echo "$SCAN" | grep -q "DB_PASSWORD" \
  && ok "scan reached the app and returned its variable names (control)" \
  || { bad "scan returned nothing recognisable — later checks would be vacuous"; echo "$SCAN" | head -c 200 | sed 's/^/       /'; exit 1; }

echo "── No response may carry the plaintext"
for ep in \
  "secrets.scan|{\"0\":{\"json\":{\"appName\":\"leaky\"}}}" \
  "secrets.vault|{\"0\":{\"json\":null,\"meta\":{\"values\":[\"undefined\"],\"v\":1}}}" \
  "apps.list|{\"0\":{\"json\":null,\"meta\":{\"values\":[\"undefined\"],\"v\":1}}}" \
  "apps.get|{\"0\":{\"json\":{\"name\":\"leaky\"}}}" \
  "plans.compile|{\"0\":{\"json\":{\"apps\":[\"leaky\"]}}}" \
; do
  name="${ep%%|*}"; input="${ep##*|}"
  body=$(trpc "$name" "$input")
  if echo "$body" | grep -q "$SENTINEL"; then
    bad "🚨 $name returned the plaintext secret"
  else
    ok "$name carries no plaintext"
  fi
done

echo "── The value is genuinely present on disk (so the checks above mean something)"
grep -q "$SENTINEL" "$H/etc/apps/leaky/docker-compose.yml" \
  && ok "the sentinel really is in the app's compose" \
  || bad "the fixture never had the sentinel — every check above proves nothing"

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
