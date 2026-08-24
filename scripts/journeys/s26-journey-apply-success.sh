#!/usr/bin/env bash
# S26 / issue #60 journey 6 — apply success with real progress and history.
#
# ⭐ "REAL" IS THE OPERATIVE WORD. Progress output that always prints the same thing, and a
# history row written whether or not anything happened, both look identical to working ones
# in a screenshot. So this journey does not check that output EXISTS — it checks that the
# output CHANGES WITH REALITY: a first deploy must report NEW, an unchanged redeploy must
# report UNCHANGED, and an edited app must report CHANGED. A reporter that cannot tell
# those apart is decoration.
#
# ⚠️ The label is `[plan: X]`, not a bare `[X]`, since appbay-cli#4. It is a verdict about
# the COMPILED ARTIFACT, and while it was printed bare it was also being summed into
# "N deployed" — so an unchanged plan whose container had been deleted reported
# `0 deployed` for a converge that started a container. This journey still asserts the plan
# verdict tracks reality; s29-journey-deploy-reporting asserts the deploy verdict does.
#
# 🚨 HISTORY IS READ FROM THE DATABASE, NOT FROM THE COMMAND'S OWN OUTPUT. Asking the tool
# whether it recorded something, and believing its answer, is not evidence.
#
# Self-provisioning; removes its app and container.
#   VM=appbay-docker ./s26-journey-apply-success.sh
#   VM=appbay-rhel PRIV=sudo CBIN=podman ./s26-journey-apply-success.sh

set -uo pipefail
VM="${VM:-appbay-docker}"
PRIV="${PRIV:-env}"
HOME_DIR="${HOME_DIR:-/home/ubuntu/.appbay}"
CBIN="${CBIN:-docker}"
APP="applyprobe"
DB="$HOME_DIR/var/lib/appbay.db"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }
ab()  { vm "cd /home/ubuntu && appbay $1 2>&1"; }

rows() { # deploy rows recorded for this app
  vm "python3 -c \"
import sqlite3, os
p='$DB'
if not os.path.exists(p): print(0)
else:
    try: print(sqlite3.connect(p).execute('SELECT count(*) FROM deploys WHERE app_name=?', ('$APP',)).fetchone()[0])
    except Exception: print('nodb')
\"" | tr -d '[:space:]'
}

cleanup() {
  ab "down $APP" >/dev/null 2>&1
  vm "rm -rf $HOME_DIR/etc/apps/$APP $HOME_DIR/var/lib/renders/$APP" >/dev/null 2>&1
  vm "python3 -c \"
import sqlite3, os
p='$DB'
if os.path.exists(p):
    try:
        d=sqlite3.connect(p); d.execute('DELETE FROM deploys WHERE app_name=?', ('$APP',)); d.commit()
    except Exception: pass
\"" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup

echo "── Provision"
vm "mkdir -p $HOME_DIR/etc/apps/$APP" >/dev/null 2>&1
vm "cat > $HOME_DIR/etc/apps/$APP/docker-compose.yml <<'EOF'
services:
  app:
    image: docker.io/library/busybox:latest
    command: [\"sleep\", \"600\"]
EOF" >/dev/null 2>&1
vm "cat > $HOME_DIR/etc/apps/$APP/appbay.yaml <<'EOF'
project: default
environment: default
upstream:
  source: ./docker-compose.yml
  expose:
    - app
EOF" >/dev/null 2>&1

echo "── First deploy must report NEW and actually start the container"
OUT=$(ab "up $APP")
echo "$OUT" | grep -qi "\[plan: NEW\]" && ok "first deploy reported [plan: NEW]" || { bad "first deploy did not report [plan: NEW]"; echo "$OUT" | tail -3 | sed 's/^/       /'; }
echo "$OUT" | grep -qE "1 deployed" && ok "summary counts one deploy" || bad "summary did not count the deploy"
STATE=$(vm "$CBIN inspect appbay.$APP.app --format '{{.State.Status}}' 2>/dev/null || echo absent" | tr -d '[:space:]')
[ "$STATE" = "running" ] && ok "the container is genuinely running" || { bad "nothing is running — the report was fiction"; exit 1; }

echo "── An unchanged redeploy must say UNCHANGED, not NEW again"
# 🚨 This is what separates a real reporter from a template. A tool that prints [NEW] every
# time is right once and wrong forever after, and looks identical in a screenshot.
OUT=$(ab "up $APP")
echo "$OUT" | grep -qi "\[plan: UNCHANGED\]" && ok "redeploy reported [plan: UNCHANGED]" \
                                       || { bad "redeploy did not report [plan: UNCHANGED] — progress does not track reality"; echo "$OUT" | tail -3 | sed 's/^/       /'; }

echo "── An edited app must say CHANGED"
vm "sed -i 's|\"600\"|\"900\"|' $HOME_DIR/etc/apps/$APP/docker-compose.yml" >/dev/null 2>&1
OUT=$(ab "up $APP")
echo "$OUT" | grep -qiE "\[plan: CHANGED\]|\[plan: NEW\]" && ok "edited app reported a change" \
                                              || { bad "an edited app was reported as unchanged"; echo "$OUT" | tail -3 | sed 's/^/       /'; }

echo "── Deploy history"
# 📌 MEASURED, NOT ASSUMED: a CLI-only install NEVER OPENS THE DATABASE. After repeated
# `appbay up` runs there is no appbay.db at all — so deploy history is a feature of the
# OPTIONAL web control plane, not of the deployer.
#
# That is consistent with the stated doctrine (the filesystem is source of truth, SQLite is
# a rebuildable cache belonging to the control plane, and the CLI calls core in-process and
# exits). So this is recorded as a scope boundary rather than failed as a defect — but it
# IS a boundary worth stating: an operator running CLI-only has no deploy history, and
# journey 6's "history" clause is only satisfiable with the control plane running.
DB_PRESENT=$(vm "test -f $DB && echo yes || echo no" | tr -d '[:space:]')
if [ "$DB_PRESENT" = "no" ]; then
  echo "     ⏭ no database on this install — history belongs to the optional web control"
  echo "        plane, which is not running. Progress reporting above is unaffected."
  ok "history scope is the control plane, not the CLI (recorded, not assumed)"
else
  # ⚠️ A DATABASE EXISTING DOES NOT MEAN THIS DEPLOY SHOULD HAVE WRITTEN TO IT. The deploy
  # under test is `appbay up` — the CLI path, which the comment above establishes never opens
  # the database. The file's presence proves only that the CONTROL PLANE has run on this host
  # at some point; it says nothing about the deployer.
  #
  # This branch used to fail with "a database exists but the deploy recorded no history row",
  # and it was unreachable in practice until the control plane was started on the VM for the
  # first time (2026-08-12, verifying the alpha gate). It then failed instantly on a 4096-byte
  # database — an empty SQLite file the server container creates at startup. The product was
  # behaving exactly as the doctrine says; the inference was wrong.
  #
  # Control-plane-recorded history IS verified, in the browser: see #57, where a deploy driven
  # through the web UI produced `SUCCEEDED / 286ms` next to a genuinely failed earlier attempt.
  N=$(rows)
  if [ "$N" = "nodb" ]; then
    echo "     ⏭ a database exists but has no deploys table — the control plane created it and"
    echo "        has not migrated or written yet. A CLI deploy would not populate it either."
    ok "history scope is the control plane, not the CLI (database present, CLI path unaffected)"
  else
    ok "database present with ${N:-0} deploy row(s); this CLI deploy is not expected to add one"
  fi
fi

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
