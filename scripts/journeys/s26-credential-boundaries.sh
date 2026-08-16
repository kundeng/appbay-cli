#!/usr/bin/env bash
# S26 task 3.2 — the three credential domains are independent.
#
# ⭐ THE CLAIM UNDER TEST IS ASSERTED EVERYWHERE AND CHECKED NOWHERE. S25 split credentials
# into three domains that are never synchronized:
#
#   control-plane account  — signs in to AppBay itself   → etc/control-plane/users.yaml
#   edge identity          — signs in to DEPLOYED APPS    → Caddy Security users.json
#   vault password         — unlocks the secret store     → vault.enc
#
# Every help string, doc and issue comment repeats it (see #64). But "never synchronized" is
# a property, and a property nobody exercises is a wish. The failure it guards against is
# quiet in the worst way: a reset that touches a neighbouring domain locks an operator out
# of something they were not even changing, and nothing reports it.
#
# 🚨 THE ASSERTION IS ON THE STORED CREDENTIAL, NOT ON THE COMMAND'S EXIT CODE. A reset that
# silently rewrote a sibling store would exit 0 and print success. This hashes each of the
# three stores before and after every operation and requires exactly one to move.
#
# Self-provisioning; leaves no accounts behind.
#   VM=appbay-docker ./s26-credential-boundaries.sh
#   VM=appbay-rhel PRIV=sudo ./s26-credential-boundaries.sh

set -uo pipefail
VM="${VM:-appbay-docker}"
PRIV="${PRIV:-env}"
HOME_DIR="${HOME_DIR:-/home/ubuntu/.appbay}"
CP="$HOME_DIR/etc/control-plane/users.yaml"
EDGE="$HOME_DIR/etc/apps/caddy/config/security/users.json"
VAULT="$HOME_DIR/var/lib/vault.enc"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }
ab()  { vm "cd /home/ubuntu && appbay $1 2>&1"; }

# sha of a store, or "absent". Never prints contents — these files hold credentials.
sha() { vm "test -f $1 && sha256sum $1 | cut -d' ' -f1 || echo absent" | tr -d '[:space:]'; }

PROVISIONED_CP=no
PROVISIONED_DB=no

cleanup() {
  # ⚠️ Remove ONLY what this journey created. If the install already had a control-plane
  # account we must not touch it — leaving a synthetic one behind would put credentials on
  # a host that had none, which is worse than an untidy test.
  if [ "$PROVISIONED_CP" = "yes" ]; then
    vm "rm -f $CP" >/dev/null 2>&1
  fi

  # The staged legacy install needs a MINIMAL appbay.db (users + sessions only). Leaving it
  # behind gave a later journey a database missing every other table, which read as a
  # product defect until traced — so remove it.
  #
  # 🚨 Identified by SHAPE, not by a flag: a real AppBay database always has a `deploys`
  # table (createDatabase runs the full DDL); ours never does. Shape also cleans up after a
  # run that crashed before any flag was set, which flag logic cannot. SQLite is a
  # rebuildable cache by design, so removing it is safe.
  #
  # ⚠️ grep, not a nested python heredoc — SQLite stores table names as plain text, so this
  # needs no interpreter. Every python-through-multipass-through-bash attempt in these
  # journeys has arrived mangled at least once.
  vm "test -f $HOME_DIR/var/lib/appbay.db && ! grep -qa deploys $HOME_DIR/var/lib/appbay.db && rm -f $HOME_DIR/var/lib/appbay.db" >/dev/null 2>&1

  ab "edge users list" >/dev/null 2>&1
  vm "python3 - <<'PY'
import json, os
p = '$EDGE'
if os.path.exists(p):
    d = json.load(open(p))
    d['users'] = [u for u in d.get('users', []) if u.get('username') != 'boundary-edge']
    json.dump(d, open(p, 'w'), indent=2)
PY" >/dev/null 2>&1
}

trap cleanup EXIT

echo "── Stage one credential in each domain"
CP_EXISTS=$(vm "test -f $CP && echo yes || echo no" | tr -d '[:space:]')
if [ "$CP_EXISTS" != "yes" ]; then
  # ⚠️ THERE IS NO CLI COMMAND THAT CREATES A CONTROL-PLANE ACCOUNT — `appbay admin` only
  # resets one, and creation lives in the web setup wizard. That is coherent (the account
  # exists to sign in to the OPTIONAL web UI, so a CLI-only install rightly has none), but
  # it means this journey cannot assume one and must not silently skip either: a skipped
  # boundary check reads exactly like a passing one in a summary.
  #
  # So provision the legacy way, which exercises real code: seed the SQLite row and let
  # `admin reset-password` perform its one-time export into users.yaml (proven by
  # s26-legacy-user-migration.sh).
  echo "     no control-plane account — provisioning one via the legacy export path"
  vm "mkdir -p $HOME_DIR/var/lib" >/dev/null 2>&1
  PROVISIONED_DB=$(vm "test -f $HOME_DIR/var/lib/appbay.db && echo no || echo yes" | tr -d '[:space:]')
  vm "python3 - <<'PY'
import sqlite3, os
p = '$HOME_DIR/var/lib/appbay.db'
db = sqlite3.connect(p)
db.execute('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)')
db.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT)')
db.execute(\"INSERT OR REPLACE INTO users VALUES ('u-bnd','boundaryadmin',?,'2026-01-01T00:00:00.000Z')\", ('a'*32 + ':' + 'b'*128,))
db.commit()
PY" >/dev/null 2>&1
  vm "cd /home/ubuntu && appbay admin reset-password boundaryadmin --generate" >/dev/null 2>&1
  CP_EXISTS=$(vm "test -f $CP && echo yes || echo no" | tr -d '[:space:]')
  [ "$CP_EXISTS" = "yes" ] || { bad "could not provision a control-plane account"; exit 1; }
  PROVISIONED_CP=yes
fi
CP_USER=$(vm "grep -m1 'username:' $CP | awk '{print \$2}'" | tr -d '[:space:]')
[ -n "$CP_USER" ] && ok "control-plane account present: $CP_USER" || { bad "could not read a control-plane username"; exit 1; }

ab "edge users create boundary-edge --email boundary@example.invalid --generate" >/dev/null 2>&1
vm "grep -q boundary-edge $EDGE" >/dev/null 2>&1 && ok "edge identity created: boundary-edge" || { bad "could not create an edge identity"; exit 1; }

VAULT_EXISTS=$(vm "test -f $VAULT && echo yes || echo no" | tr -d '[:space:]')
[ "$VAULT_EXISTS" = "yes" ] && ok "vault present" || { bad "no vault on this install — run 'appbay secrets init'"; exit 1; }

echo "── Reset the CONTROL-PLANE password: only that store may change"
A1=$(sha "$CP"); B1=$(sha "$EDGE"); C1=$(sha "$VAULT")
ab "admin reset-password $CP_USER --generate" >/dev/null 2>&1
A2=$(sha "$CP"); B2=$(sha "$EDGE"); C2=$(sha "$VAULT")
[ "$A1" != "$A2" ] && ok "control-plane store changed (the reset took effect)" || bad "control-plane store did NOT change — the reset did nothing"
[ "$B1" = "$B2" ] && ok "edge identity store untouched" || bad "🚨 the edge store CHANGED — domains are synchronized"
[ "$C1" = "$C2" ] && ok "vault untouched" || bad "🚨 the vault CHANGED — domains are synchronized"

echo "── Reset an EDGE password: only that store may change"
A1=$(sha "$CP"); B1=$(sha "$EDGE"); C1=$(sha "$VAULT")
ab "edge users reset-password boundary-edge --generate" >/dev/null 2>&1
A2=$(sha "$CP"); B2=$(sha "$EDGE"); C2=$(sha "$VAULT")
[ "$B1" != "$B2" ] && ok "edge identity store changed (the reset took effect)" || bad "edge store did NOT change — the reset did nothing"
[ "$A1" = "$A2" ] && ok "control-plane store untouched" || bad "🚨 the control-plane store CHANGED — resetting an app password touched the AppBay account"
[ "$C1" = "$C2" ] && ok "vault untouched" || bad "🚨 the vault CHANGED — domains are synchronized"

echo "── The stores are genuinely separate files"
# ⚠️ Distinct paths is not a detail — one shared file would make every assertion above
# accidental rather than designed.
DISTINCT=$(vm "printf '%s\n%s\n%s\n' \$(readlink -f $CP) \$(readlink -f $EDGE) \$(readlink -f $VAULT) | sort -u | wc -l" | tr -d '[:space:]')
[ "$DISTINCT" = "3" ] && ok "three distinct files back the three domains" || bad "expected 3 distinct store paths, found $DISTINCT"

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
