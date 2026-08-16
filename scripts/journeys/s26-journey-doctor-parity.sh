#!/usr/bin/env bash
# S26 / issue #71 — the CLI and the web report the SAME health, because they run the same code.
#
# ⭐ WHY A JOURNEY AND NOT A UNIT TEST. "One implementation, two interfaces" is a claim about
# two processes reading one machine, and the way it failed was invisible to every unit test in
# the repo: the web had its OWN doctor, so on a Podman host it reported "Docker daemon is not
# reachable" ON A HEALTHY MACHINE while `appbay doctor` on the same box reported everything
# green. Both were internally consistent. Only comparing them catches it.
#
# 🚨 THE COMPARISON MUST BE ABLE TO FAIL. Two interfaces that both return an EMPTY check list
# agree perfectly — the same trap as `s25-interface-optionality.sh` comparing 000 to 000. This
# journey therefore asserts a floor on the number of checks and that a named, always-present
# check appears in both, BEFORE it compares any verdicts.
#
# Runs locally (needs the repo, the built CLI and pnpm), against a throwaway install.
#   ./s26-journey-doctor-parity.sh

set -uo pipefail
REPO="${REPO:-$HOME/src/appbay}"
PORT="${PORT:-3778}"
SCRATCH="${SCRATCH:-/tmp/appbay-doctor-parity}"
H="$SCRATCH/home"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

cleanup() {
  for p in $(ss -lptn "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u); do kill "$p" 2>/dev/null || true; done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
cleanup
mkdir -p "$H"

echo "── A throwaway install both interfaces will read"
"$REPO/apps/cli/dist/appbay" init --dir "$H" --domain parity.test.local --project parity >/dev/null 2>&1
[ -d "$H/etc" ] && ok "install scaffolded at $H" || { bad "init did not scaffold"; exit 1; }

echo "── The CLI's view"
# ⚠️ APPBAY_HOME, not --dir. `init --dir` persists a machine-wide default in
# ~/.config/appbay/home; the env var wins and leaves the workstation untouched.
CLI_JSON=$(APPBAY_HOME="$H" "$REPO/apps/cli/dist/appbay" doctor --json 2>/dev/null)
CLI_N=$(echo "$CLI_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["checks"]))' 2>/dev/null || echo 0)
[ "${CLI_N:-0}" -ge 10 ] \
  && ok "CLI reports $CLI_N checks" \
  || { bad "CLI reported ${CLI_N:-0} checks — every comparison below would be vacuous"; exit 1; }

echo "── The web's view of the same install"
( cd "$REPO" && APPBAY_HOME="$H" APPBAY_DEV_AUTH=true PORT="$PORT" pnpm --filter @appbay/web dev >"$SCRATCH/web.log" 2>&1 & )
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" 2>/dev/null)" = "200" ] && break
  sleep 2
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" 2>/dev/null)" = "200" ] \
  && ok "server up on :$PORT" || { bad "server did not start"; tail -5 "$SCRATCH/web.log" | sed 's/^/       /'; exit 1; }

WEB_RAW=$(curl -s --max-time 60 "http://localhost:$PORT/api/trpc/doctor.run?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%2C%22v%22%3A1%7D%7D%7D")
echo "$WEB_RAW" > "$SCRATCH/web.json"

# Extract the web's checks from the tRPC envelope, tolerating both superjson and plain shapes.
python3 - "$SCRATCH/web.json" > "$SCRATCH/web-checks.json" <<'PY'
import json, sys
raw = json.load(open(sys.argv[1]))
node = raw[0] if isinstance(raw, list) else raw
d = node.get("result", {}).get("data", node)
if isinstance(d, dict) and "json" in d:
    d = d["json"]
json.dump(d, sys.stdout)
PY

WEB_N=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get("checks",[])))' "$SCRATCH/web-checks.json" 2>/dev/null || echo 0)
[ "${WEB_N:-0}" -ge 10 ] \
  && ok "web reports $WEB_N checks" \
  || { bad "web reported ${WEB_N:-0} checks"; head -c 300 "$SCRATCH/web.json" | sed 's/^/       /'; exit 1; }

echo "── Parity: same checks, same verdicts"
# ⚠️ THE COMPARISON EMITS VERDICTS, NOT SHELL VARIABLES. The first version had python print
# `ONLY_CLI=<names>` and sourced the result. Check names contain spaces ("Shared network DNS"),
# so bash read `ONLY_CLI=Shared network DNS` as a temporary assignment prefixing a command
# named `network`: the variable never persisted, stayed empty, and all four parity assertions
# reported ✅ while the web was genuinely missing a check. It was caught only by running a
# PLANTED defect against the journey (README rule 3) — a green first run had already "passed".
# Python now decides and prints `OK|…` / `BAD|…`; nothing round-trips through the shell.
CLI_JSON="$CLI_JSON" python3 "$REPO/scripts/journeys/lib/doctor_parity.py" "$SCRATCH/web-checks.json" > "$SCRATCH/parity.txt" 2>&1

while IFS='|' read -r tag msg; do
  case "$tag" in
    OK)  ok "$msg" ;;
    BAD) bad "$msg" ;;
    "")  ;;
    # Anything else means the comparator crashed. Reporting that as a failure matters: a
    # traceback read as "no output" would otherwise make every assertion silently vanish.
    *)   bad "parity comparison did not produce a verdict: $tag$msg" ;;
  esac
done < "$SCRATCH/parity.txt"

grep -qE '^(OK|BAD)\|' "$SCRATCH/parity.txt" \
  || { bad "the parity comparator produced no verdicts at all"; head -5 "$SCRATCH/parity.txt" | sed 's/^/       /'; }

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
