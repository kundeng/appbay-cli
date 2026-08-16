#!/usr/bin/env bash
# S25 task 7 — deletion and rebuild journey.
#
# Proves the invariant S25 states: deleting the DISPOSABLE SQLite cache must not
# erase the administrator or reopen first-run registration.
#
# Every assertion is an observed HTTP response or a stat() of a real file.

set -uo pipefail
BASE="${BASE:-http://127.0.0.1:3111}"
H="${APPBAY_HOME:?APPBAY_HOME must be set}"
DB="$H/var/lib/appbay.db"
USERS="$H/etc/control-plane/users.yaml"
PASS="correct-horse-battery-staple"

pass=0; fail=0
ok()   { echo "  ✅ $1"; pass=$((pass+1)); }
bad()  { echo "  ❌ $1"; fail=$((fail+1)); }
chk()  { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 — expected '$3', got '$2'"; fi; }

j() { curl -sS -m 10 "$@"; }

echo "── 1. fresh install reports setup required ──"
chk "GET /api/auth/setup" "$(j "$BASE/api/auth/setup" | python3 -c 'import json,sys;print(json.load(sys.stdin)["setupRequired"])')" "True"

echo "── 2. create the first admin ──"
code=$(j -o /tmp/s25-signup.json -w '%{http_code}' -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$PASS\"}")
# 201 Created is the correct code for signup; 200 accepted too so this does not
# become a brittle assertion about a status code the journey does not care about.
if [ "$code" = "201" ] || [ "$code" = "200" ]; then ok "POST /api/auth/signup ($code)"; else bad "POST /api/auth/signup — expected 201/200, got $code"; fi

echo "── 3. the authoritative file exists and is mode 0600 ──"
if [ -f "$USERS" ]; then ok "users.yaml written at $USERS"; else bad "users.yaml MISSING"; fi
chk "users.yaml mode" "$(stat -c '%a' "$USERS" 2>/dev/null)" "600"

echo "── 4. log in and hold a session ──"
code=$(j -o /tmp/s25-login.json -w '%{http_code}' -c /tmp/s25-cookies.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$PASS\"}")
chk "POST /api/auth/login" "$code" "200"
SESSION=$(grep appbay_session /tmp/s25-cookies.txt 2>/dev/null | awk '{print $NF}')
if [ -n "$SESSION" ]; then ok "session cookie issued"; else bad "no session cookie"; fi
chk "GET /api/auth/session (authenticated)" \
  "$(j -b /tmp/s25-cookies.txt "$BASE/api/auth/session" | python3 -c 'import json,sys;d=json.load(sys.stdin);print((d.get("user") or {}).get("username"))' 2>/dev/null)" "admin"

echo "── 5. 🚨 DELETE THE DISPOSABLE SQLITE CACHE ──"
rm -f "$DB" "$DB-wal" "$DB-shm"
if [ ! -f "$DB" ]; then ok "appbay.db deleted"; else bad "appbay.db still present"; fi
if [ -f "$USERS" ]; then ok "users.yaml survived (it is the source of truth)"; else bad "users.yaml gone"; fi

echo "── 6. THE REGRESSION: setup must NOT reopen ──"
chk "GET /api/auth/setup after cache loss" \
  "$(j "$BASE/api/auth/setup" | python3 -c 'import json,sys;print(json.load(sys.stdin)["setupRequired"])')" "False"

echo "── 7. signup stays refused ──"
code=$(j -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' -d '{"username":"intruder","password":"hunter2hunter2"}')
chk "POST /api/auth/signup after cache loss" "$code" "403"

echo "── 8. the old password still authenticates ──"
code=$(j -o /dev/null -w '%{http_code}' -c /tmp/s25-cookies2.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$PASS\"}")
chk "POST /api/auth/login after cache loss" "$code" "200"

echo "── 9. the PRIOR session is invalid (sessions were disposable) ──"
chk "GET /api/auth/session with pre-deletion cookie" \
  "$(j -b /tmp/s25-cookies.txt "$BASE/api/auth/session" | python3 -c 'import json,sys;d=json.load(sys.stdin);print((d.get("user") or {}).get("username"))' 2>/dev/null)" "None"

echo
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
