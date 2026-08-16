#!/usr/bin/env bash
# S26 task 3.6 — the one-time export of legacy SQLite users into users.yaml.
#
# ⭐ WHY THIS NEEDS A JOURNEY. S25 made the FILESYSTEM authoritative for control-plane
# users; SQLite became a disposable cache. Installs that predate that change have their
# only copy of the admin account in SQLite, so `appbay admin` carries a one-time export:
# read the legacy rows, write users.yaml, continue. Nothing exercised it. An export that
# runs on every invocation would silently discard accounts added since — and an export that
# never runs locks the operator out of their own install.
#
# 🚨 THE SECOND-RUN CHECK IS THE POINT. Proving the export happens is easy; proving it
# happens ONCE is what protects the data. This adds a user to users.yaml that does NOT
# exist in SQLite, then runs again: if the export re-ran, that user is gone.
#
# Self-provisioning — builds a legacy install in a throwaway APPBAY_HOME and removes it.
#   VM=appbay-docker ./s26-legacy-user-migration.sh

set -uo pipefail
VM="${VM:-appbay-docker}"
PRIV="${PRIV:-env}"
H="/tmp/appbay-legacy-journey"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }

cleanup() { vm "rm -rf $H" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup

echo "── Build a PRE-S25 install: users in SQLite, no users.yaml"
vm "mkdir -p $H/var/lib $H/etc" >/dev/null 2>&1
vm "python3 - <<'PY'
import sqlite3
db = sqlite3.connect('$H/var/lib/appbay.db')
db.execute('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)')
db.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT)')
# ⚠️ A REAL scrypt hash SHAPE: <32 hex salt>:<128 hex hash>. The schema enforces it, and a
# placeholder string makes the export fail validation — which looks like a product defect
# until you read the ZodError.
salt = 'a' * 32
h = 'b' * 128
db.execute(\"INSERT INTO users VALUES ('u-legacy','legacyadmin',?,'2026-01-01T00:00:00.000Z')\", (salt + ':' + h,))
db.execute(\"INSERT INTO sessions VALUES ('s-1','u-legacy','2030-01-01T00:00:00.000Z')\")
db.commit()
PY" >/dev/null 2>&1
HAS_DB=$(vm "test -f $H/var/lib/appbay.db && echo yes || echo no" | tr -d '[:space:]')
NO_YAML=$(vm "test -f $H/etc/control-plane/users.yaml && echo present || echo absent" | tr -d '[:space:]')
[ "$HAS_DB" = "yes" ] && [ "$NO_YAML" = "absent" ] && ok "legacy install staged (SQLite only, no users.yaml)" \
                                                   || bad "could not stage the legacy install"

echo "── First run: the export must happen"
OUT=$(vm "cd /home/ubuntu && APPBAY_HOME=$H appbay admin reset-password legacyadmin --generate --reveal 2>&1")
echo "$OUT" | grep -qi "Password reset for local AppBay user: legacyadmin" \
  && ok "reset succeeded against a legacy install" \
  || { bad "reset failed on a legacy install"; echo "$OUT" | tail -3 | sed 's/^/       /'; }

CREATED=$(vm "test -f $H/etc/control-plane/users.yaml && echo yes || echo no" | tr -d '[:space:]')
[ "$CREATED" = "yes" ] && ok "users.yaml created from the SQLite rows" || bad "users.yaml was NOT created"

# 🚨 The file holds password hashes. World-readable here would be a credential leak that
# no other check in the project would notice.
MODE=$(vm "stat -c %a $H/etc/control-plane/users.yaml 2>/dev/null" | tr -d '[:space:]')
[ "$MODE" = "600" ] && ok "users.yaml is mode 0600" || bad "users.yaml is mode $MODE, expected 600"

vm "grep -q legacyadmin $H/etc/control-plane/users.yaml" >/dev/null 2>&1 \
  && ok "the legacy account survived the export" || bad "legacy account missing from users.yaml"

# Sessions belonging to the reset user must be gone — a reset that leaves a live session
# has not locked anyone out.
SESS=$(vm "python3 -c \"import sqlite3;print(sqlite3.connect('$H/var/lib/appbay.db').execute('SELECT count(*) FROM sessions').fetchone()[0])\"" | tr -d '[:space:]')
[ "$SESS" = "0" ] && ok "existing sessions invalidated" || bad "$SESS session(s) survived the reset"

echo "── Second run: the export must NOT repeat"
# Add an account that exists ONLY in users.yaml. A re-export rebuilds from SQLite and would
# erase it — which is exactly how a repeated export destroys accounts added after migration.
# ⚠️ Plain shell append, not a nested python heredoc. The earlier version went through
# multipass -> bash -> python and arrived with its newlines mangled, producing invalid YAML
# — which made the SECOND RUN FAIL and the survival check below pass for the wrong reason.
# Same trap as the base64 note in tests/bdd/fixtures.resource: every layer has an opinion
# about quoting, so give them nothing to interpret.
SALT="cccccccccccccccccccccccccccccccc"
HASH="$(printf 'd%.0s' $(seq 1 128))"
vm "cat >> $H/etc/control-plane/users.yaml <<EOF
  - id: u-after
    username: addedlater
    passwordHash: ${SALT}:${HASH}
    status: active
    createdAt: 2026-06-01T00:00:00.000Z
    updatedAt: 2026-06-01T00:00:00.000Z
EOF" >/dev/null 2>&1
BEFORE=$(vm "grep -c addedlater $H/etc/control-plane/users.yaml" | tr -d '[:space:]')

# 🚨 ASSERT THE SECOND RUN SUCCEEDED, not merely that the extra account survived. If the
# run ERRORED it would also leave the file untouched, and this check would pass for exactly
# the wrong reason — a green tick over a command that never did anything.
OUT2=$(vm "cd /home/ubuntu && APPBAY_HOME=$H appbay admin reset-password legacyadmin --generate 2>&1")
echo "$OUT2" | grep -qi "Password reset for local AppBay user: legacyadmin" \
  && ok "second run succeeded" \
  || { bad "second run failed — the survival check below would be meaningless"; echo "$OUT2" | tail -2 | sed 's/^/       /'; }
AFTER=$(vm "grep -c addedlater $H/etc/control-plane/users.yaml" | tr -d '[:space:]')
[ "$BEFORE" = "1" ] && [ "$AFTER" = "1" ] \
  && ok "second run did NOT re-export (the file-only account survived)" \
  || bad "the file-only account was lost — the export repeated and destroyed data"

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
