#!/usr/bin/env bash
# Does a human judgement survive a rebuild, while generated columns refresh?
#
# The store's contract is that generated columns are re-derived on every build and human
# columns are read back and merged, never truncated. That is a claim about the builder,
# and an untested read-back-merge is how human state gets silently destroyed.
#
# Procedure: change a decision by hand (as a maintainer would), damage a generated column,
# rebuild, and check that the human edit survived and the generated column was restored.
set -uo pipefail
DIR=${ST_DIR:?set ST_DIR}
cd "$DIR"
DB=appbay-dockhand-systematic-compose-state.db

echo "===== before ====="
sqlite3 -header -column "$DB" "SELECT gap_id, decision, spec, blast_radius FROM gap WHERE gap_id IN ('G6','G1')"

echo
echo "===== a maintainer overrules G6 and damages a generated column ====="
sqlite3 "$DB" <<'SQL'
UPDATE gap SET decision='leave',
               rationale='Deferred: stage 0 of SPEC-006 is a product decision, not scheduled work.'
 WHERE gap_id='G6';
INSERT INTO audit_decision (at,who,table_name,row_key,field,old_value,new_value,why,evidence)
VALUES (datetime('now'),'kundeng','gap','G6','decision','close','leave',
        'Deferred pending the reading-(a)-or-(b) decision in SPEC-006 stage 0.','[F8]');
UPDATE gap SET blast_radius='CLOBBERED' WHERE gap_id='G1';
SQL
sqlite3 -header -column "$DB" "SELECT gap_id, decision, blast_radius FROM gap WHERE gap_id IN ('G6','G1')"

echo
echo "===== rebuild ====="
python3 src/appbay-dockhand/build_store.py "$DB"

echo
echo "===== after: human edit preserved, generated column refreshed? ====="
sqlite3 -header -column "$DB" "SELECT gap_id, decision, spec, blast_radius FROM gap WHERE gap_id IN ('G6','G1')"

echo
echo "===== decision log is append-only ====="
sqlite3 -header -column "$DB" "SELECT at,who,row_key,field,old_value,new_value FROM audit_decision ORDER BY rowid DESC LIMIT 3"
echo "total decision rows: $(sqlite3 "$DB" 'SELECT count(*) FROM audit_decision')"

echo
echo "===== verdict ====="
g6=$(sqlite3 "$DB" "SELECT decision FROM gap WHERE gap_id='G6'")
g1=$(sqlite3 "$DB" "SELECT blast_radius FROM gap WHERE gap_id='G1'")
[ "$g6" = "leave" ] && echo "PASS: the human edit survived the rebuild (G6.decision=leave)" || echo "FAIL: human edit lost (G6.decision=$g6)"
case "$g1" in CLOBBERED) echo "FAIL: generated column was not refreshed";; *) echo "PASS: generated column refreshed from the record ($g1)";; esac

echo
echo "===== restore the seeded decision, leaving the log intact ====="
sqlite3 "$DB" <<'SQL'
UPDATE gap SET decision='close',
  rationale='The only structural gap. Staged, and stage 0 is a decision rather than code — do not start before SPEC-001..004.'
 WHERE gap_id='G6';
INSERT INTO audit_decision (at,who,table_name,row_key,field,old_value,new_value,why,evidence)
VALUES (datetime('now'),'kundeng','gap','G6','decision','leave','close',
        'Round-trip probe complete; restoring the decision this investigation actually recommends.','[F8]');
SQL
sqlite3 -header -column "$DB" "SELECT gap_id, decision FROM gap WHERE gap_id='G6'"
echo "decision rows now: $(sqlite3 "$DB" 'SELECT count(*) FROM audit_decision') (nothing deleted)"
