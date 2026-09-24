#!/usr/bin/env python3
"""Build the investigation's ledger: one row per identified gap, with the human judgement.

Two column families, and the boundary matters:
  * GENERATED — re-derivable from the records on every build (which record proved the gap,
    which finding it became, the blast radius CodeGraph reported).
  * HUMAN — the decision to close a gap or leave it, and why. Nothing recomputes these;
    they are read back and preserved, never truncated.

Every judgement change appends to audit_decision, which is never updated or deleted.
"""
from __future__ import annotations
import sqlite3, sys, datetime
from pathlib import Path

DB = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("appbay-dockhand-systematic-compose-state.db")
WHO = "kundeng"
NOW = datetime.datetime.now().astimezone().isoformat(timespec="seconds")

SCHEMA = """
CREATE TABLE IF NOT EXISTS gap (
  gap_id       TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  -- generated, refreshed from the records on every build
  finding      TEXT,
  record       TEXT,
  blast_radius TEXT,
  -- human judgement, seeded once and never overwritten
  decision     TEXT,   -- close | leave
  spec         TEXT,
  rationale    TEXT);

CREATE TABLE IF NOT EXISTS audit_lineage (
  table_name TEXT NOT NULL, row_key TEXT, column_name TEXT NOT NULL,
  probe_file TEXT NOT NULL, tool_query TEXT, generated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS audit_decision (
  at TEXT NOT NULL, who TEXT NOT NULL, table_name TEXT NOT NULL, row_key TEXT,
  field TEXT, old_value TEXT, new_value TEXT, why TEXT NOT NULL, evidence TEXT);
"""

# (gap_id, title, finding, record, blast_radius, tool_query)
GENERATED = [
 ("G1","Map-form environment is silently lost","F3",
  "raw/probe-05-map-form-environment-is-handled-three-ways.yaml",
  "scopedEnvTraitDefinition: 4 callers (2 tests, 2 barrels)","codegraph callers scopedEnvTraitDefinition"),
 ("G2","Web deploy path drops auxiliaryFiles","F5",
  "raw/analysis-13-web-deploy-drops-the-edge-route.yaml",
  "1 auxiliaryFiles reference under apps/web/src, display-only","grep -rn auxiliaryFiles apps/web/src"),
 ("G3","Default edge cannot run the auth trait","F6",
  "raw/probe-04-untouched-compose-compiles-under-both-edges.yaml",
  "DEFAULT_INGRESS_PROVIDER: 3 call sites","grep -rn DEFAULT_INGRESS_PROVIDER"),
 ("G4","Stale lockfile breaks the release workflow","F7",
  "raw/action-01-appbay-builds-from-the-snapshot.yaml",
  "release.yml:53; ci.yml disabled","n/a — build execution"),
 ("G5","Only 4 of 47 commands emit JSON","F13",
  "raw/probe-08-cli-exposure-top-level-commands.yaml",
  "43 commands without --json","appbay <cmd> --help per command"),
 ("G6","No multi-host support","F8",
  "raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml",
  "containerBin impact: 67 symbols; route delivery is a local write","codegraph impact containerBin"),
 ("G7","Backup trait is declared but unwired","F14",
  "raw/analysis-12-appbay-declared-but-unreachable-surface.yaml",
  "ShepherdAction.schedule: 0 readers; on-stop: 0 producers","grep producers/readers per phase"),
 ("G8","No per-operator RBAC or audit trail","F9",
  "raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml",
  "AppBay edge-user surface: 3 verbs","appbay edge users --help"),
 ("G9","GUI breadth an order of magnitude behind","F10",
  "raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml",
  "129,226 vs 25,550 lines; 21 vs 9 pages","file and line counts"),
 ("G10","No vulnerability scanning, registries, image-update tracking","F8",
  "raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml",
  "4 Dockhand tables with scheduled tasks","schema read"),
]

# Seeded ONCE. A later build must not overwrite an edited decision.
SEED_JUDGEMENT = {
 "G1": ("close","SPEC-001","Only finding that destroys operator data; blast radius is four callers, two of them the tests that assert the loss."),
 "G2": ("close","SPEC-002","The GUI drops the product's distinguishing output. Undercuts the stated purpose more directly than any other defect."),
 "G3": ("close","SPEC-003","A default that contradicts the documented happy path. Single-sourced constant; the migration hazard is the real work."),
 "G4": ("close","SPEC-004","One command fixes it and it unblocks releases plus six written-but-unrun checks."),
 "G5": ("close","SPEC-005","Upstream of MCP and of web/CLI convergence; the concrete form of the exposure thesis."),
 "G6": ("close","SPEC-006","The only structural gap. Staged, and stage 0 is a decision rather than code — do not start before SPEC-001..004."),
 "G7": ("close","SPEC-007","Two shipped apps declare backups that never run. Emit the invocation; do not build the engine."),
 "G8": ("leave","SPEC-000 §1","RFC-001 §1 made the edge the sole identity authority. Building this recreates exactly what that RFC deleted."),
 "G9": ("leave","SPEC-000 §2","Different product category. ~100k lines of UI for capabilities Docker Desktop and Portainer already provide."),
 "G10":("leave","SPEC-000 §4","Commodity; good standalone tools exist; no interaction with the trait compiler."),
}

con = sqlite3.connect(DB)
con.executescript(SCHEMA)
cur = con.cursor()

# 1. READ BACK human state first, so a rebuild can never truncate it.
existing = {r[0]: (r[1], r[2], r[3]) for r in
            cur.execute("SELECT gap_id, decision, spec, rationale FROM gap")}

for gap_id, title, finding, record, blast, query in GENERATED:
    # 2. SEED human columns only where absent.
    decision, spec, rationale = existing.get(gap_id, (None, None, None))
    if decision is None:
        decision, spec, rationale = SEED_JUDGEMENT[gap_id]
        cur.execute(
            "INSERT INTO audit_decision (at,who,table_name,row_key,field,old_value,new_value,why,evidence)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (NOW, WHO, "gap", gap_id, "decision", None, decision,
             rationale, f"[{finding}] {record}"))
    # 3. REFRESH generated columns, 4. merge-write. Never a truncating replace.
    cur.execute(
        "INSERT INTO gap (gap_id,title,finding,record,blast_radius,decision,spec,rationale)"
        " VALUES (?,?,?,?,?,?,?,?)"
        " ON CONFLICT(gap_id) DO UPDATE SET"
        "   title=excluded.title, finding=excluded.finding,"
        "   record=excluded.record, blast_radius=excluded.blast_radius",
        (gap_id, title, finding, record, blast, decision, spec, rationale))
    for col, probe in (("finding", record), ("record", record), ("blast_radius", record)):
        cur.execute("DELETE FROM audit_lineage WHERE table_name='gap' AND row_key=? AND column_name=?",
                    (gap_id, col))
        cur.execute("INSERT INTO audit_lineage VALUES (?,?,?,?,?,?)",
                    ("gap", gap_id, col, probe, query, NOW))

con.commit()
counts = dict(cur.execute("SELECT decision, count(*) FROM gap GROUP BY decision").fetchall())
print(f"gaps: {cur.execute('SELECT count(*) FROM gap').fetchone()[0]}"
      f"  close: {counts.get('close', 0)}  leave: {counts.get('leave', 0)}")
print(f"decisions: {cur.execute('SELECT count(*) FROM audit_decision').fetchone()[0]}")
print(f"lineage:   {cur.execute('SELECT count(*) FROM audit_lineage').fetchone()[0]}")
con.close()
