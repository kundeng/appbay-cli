#!/usr/bin/env python3
"""Project an investigation into the work graph, and load it into a graph engine.

    python3 work-graph.py <investigation-dir>                    # write CSVs
    python3 work-graph.py <investigation-dir> --ladybug          # ... and load them (LadybugDB)
    python3 work-graph.py <investigation-dir> --kuzu             # ... legacy Kuzu 0.11 db
    python3 work-graph.py <investigation-dir> --check-only       # report only
    python3 work-graph.py <investigation-dir> --domain src/<slug>/analysis/graph_domain.py
    python3 work-graph.py <investigation-dir> --ladybug --query "MATCH (f:Finding) RETURN f.id"

ONE GRAPH, THREE LAYERS, TWO OF THEM FIXED.

    claim layer       Question Hypothesis Finding ProbeRecord Judgement Cohort
                      the claim axis — what we believe and why
    provenance layer  Run Code Artifact
                      the artifact axis — how a number was made and whether it is stale
    domain layer      your tickets, hosts, services — yours, and this script never
                      invents one
    bridge            ABOUT · DERIVES · INCLUDES — the only coupling between them

Conventions are defaults, not requirements — every location this script reads or
writes is a flag:

    --raw-dir NAME       the immutable records directory   (default raw/)
    --runs-dir NAME      the derived-runs directory        (default runs/)
    --workbook GLOB      the workbook glob                 (default INVESTIGATION-*.md)
    --db PATH            where the engine db lives         (default runs/work-graph/<engine>)
    --out DIR            where the CSVs land               (default runs/work-graph/import)

Engines: LadybugDB is the default (`--ladybug`, `import ladybug`). `--kuzu` reads and
rebuilds legacy Kuzu 0.11 dbs — same Cypher, same CSVs, single-file Ladybug vs
directory Kuzu handled by the same drop-and-recreate. New work loads LadybugDB;
`--kuzu` exists so an inherited db stays queryable until it is rebuilt.

Reads what the investigation already has — the records directory's `*.yaml`, the
workbook's Claims and Probes & analyses sections (or the pre-2026-09-01 Hypotheses /
Next probes / Findings), the runs directory's
`config.yaml` files, and the store's `audit_decision` tables — and writes
engine-neutral CSVs plus `schema.cypher`. Nothing
about how records are written has to change: the edges are already in the corpus as
`[Fnn]` / `[Hnn]` / `NPnn` citations and as the `code:` and `derived:` blocks the
helper fills in.

WHAT THIS IS NOT: a store. The records directory is immutable append-only truth and
stays that way.
This is a derived projection — droppable, rebuildable, and reconciled against the
records it came from. That is what licenses putting everything into it: a wrong model
costs a rebuild and nothing else.

🚨 A COROLLARY THAT IS EASY TO LOSE. The engine accepts `CREATE` after a load, so you can
type a judgement straight into the graph. Do not. The next rebuild deletes it and no
error says so. Judgements are written to the store; this reads them back.

Needs `yq` (mikefarah v4) on PATH — the same dependency audit-lib.sh already has.
`--ladybug` additionally needs `pip install ladybug`; `--kuzu` needs `pip install
kuzu` and is pinned to 0.11.x behaviour.
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

# ── the fixed vocabulary ──────────────────────────────────────────────────────────
# Adding to these is a change to the meta-schema, not to a project.
#
# Columns are "name" or "name:int" / "name:double". `key` is the primary key the engine
# requires. `producer` names WHERE IN THE CORPUS the rows come from — an entry with no
# producer is a declared hole, and --check-only reports it as a defect rather than
# printing a reassuring "(none found)".

Node = tuple[str, str, str]          # (key, columns, producer)

CLAIM_LAYER: dict[str, Node] = {
    "Question":    ("id", "id text status",
                    "workbook · Probes & analyses (or Next probes), rows `| NPnn | ... |`"),
    "Hypothesis":  ("id", "id text status",
                    "workbook · Claims index (or Hypotheses), rows `| Hnn | ... |` with a status glyph"),
    "Finding":     ("id", "id text standing",
                    "workbook · Claims (or Findings), `#### Fnn — claim` or `**Fnn — claim.**`"),
    "ProbeRecord": ("id", "id type timestamp verdict key_evidence command "
                          "exit_code:int output_kind file run",
                    "raw/*.yaml, one per record"),
    "Cohort":      ("id", "id definition n:int source",
                    "a record's `cohort:` key, or your domain module"),
    "Judgement":   ("id", "id at who what chose instead_of why evidence",
                    "the store's `audit_decision` table"),
}

PROVENANCE_LAYER: dict[str, Node] = {
    "Run":      ("id", "id config code_version data_epoch metrics path",
                 "runs/<run-id>/config.yaml, one per run directory"),
    "Code":     ("id", "id path sha256 stored version",
                 "record `code:` blocks"),
    "Artifact": ("id", "id path bytes:int sha256 run",
                 "record `derived:` blocks"),
}

NODES: dict[str, Node] = {**CLAIM_LAYER, **PROVENANCE_LAYER}

# (from, to, producer, needs). `*` means polymorphic: in the engine it becomes one REL TABLE
# with one FROM..TO pair per label it actually connects, and `label(x)` tells a
# traversal which kind it landed on.
#
# `needs` is what must exist in the corpus before an EMPTY edge counts as a defect.
# Most absences are ordinary — a corpus with no runs has no WROTE edges and that is
# not a problem. An empty edge whose BOTH ENDS are populated is different: it means a
# link the discipline calls for is not being written anywhere, and it reads as
# "(none found)" forever. An empty `needs` means absence is never reported.
EDGES: dict[str, tuple[str, str, str, tuple[str, ...]]] = {
    # claim layer
    "RAISES":       ("Question", "Hypothesis",
                     "an `Hnn` token in a Next probes row's second column",
                     ("questions", "hypotheses")),
    "BEARS_ON":     ("ProbeRecord", "Hypothesis",
                     "a record's `bears_on:` key, or an `[Hnn]` in its claim",
                     ("records", "hypotheses")),
    "ANSWERS":      ("ProbeRecord", "Question", "an `NPnn` in a record's claim", ()),
    "CITES":        ("Finding", "ProbeRecord", "a finding's `Evidence: raw/...yaml` line",
                     ("records", "findings")),
    "REFERS_TO":    ("ProbeRecord", "Finding", "an `[Fnn]` in a record's prose", ()),
    "MOVED_BY":     ("Hypothesis", "Finding", "the evidence column of a Hypotheses row",
                     ("hypotheses", "findings")),
    "OVER":         ("ProbeRecord", "Cohort", "a record's `cohort:` key", ()),
    # standing. The five relations are already the skill's vocabulary.
    "SUPERSEDES":   ("Finding", "Finding", "a relation word + [Fnn] in a finding's body",
                     ()),
    "REFINES":      ("Finding", "Finding", "same", ()),
    "NARROWS":      ("Finding", "Finding", "same", ()),
    "EXTENDS":      ("Finding", "Finding", "same", ()),
    "OVERTAKEN_BY": ("Finding", "Finding", "same", ()),
    "INVALIDATES":  ("ProbeRecord", "ProbeRecord",
                     "a record's `invalidates:` key — a rerun overturning an earlier one",
                     ()),
    "JUDGED":       ("Judgement", "*",
                     "`audit_decision.table_name` + `row_key` resolved to a node", ()),
    "BECAUSE":      ("Judgement", "Finding", "an `[Fnn]` in `audit_decision.evidence`",
                     ()),
    # provenance layer
    "RAN":          ("ProbeRecord", "Code", "a record's `code:` block", ("code",)),
    "PRODUCED":     ("ProbeRecord", "Artifact", "a record's `derived:` block",
                     ("derived",)),
    "IN_RUN":       ("ProbeRecord", "Run", "a record's `log:`/`derived:` path under runs/",
                     ()),
    "USED_CODE":    ("Run", "Code", "`code:` in runs/<run-id>/config.yaml", ()),
    "WROTE":        ("Run", "Artifact", "a derived path lying under runs/<run-id>/", ()),
}

# The only coupling to a project's own labels. Your module supplies the far end.
BRIDGE: dict[str, tuple[str, str, str]] = {
    "ABOUT":    ("Finding", "*",
                 "your module's bridge(): this finding is about that thing"),
    "DERIVES":  ("ProbeRecord", "*",
                 "your module's bridge(): row/cell lineage, replacing audit_lineage"),
    "INCLUDES": ("Cohort", "*",
                 "your module's bridge(): population as data, not a boolean column"),
}

#: Cypher reserved words, measured on Kuzu 0.11.3 and still true on Ladybug 0.20.1:
#: `CREATE NODE TABLE Group(...)` is a
#: parse error, not a warning. A domain module returning one is rejected at import
#: rather than at query time, when the error reads as a typo in your query.
CYPHER_RESERVED = frozenset({
    "GROUP", "ORDER", "TABLE", "FROM", "TO", "WHERE", "MATCH", "RETURN", "CREATE",
    "DELETE", "SET", "WITH", "UNION", "LIMIT", "SKIP", "BY", "AS", "AND", "OR", "NOT",
    "IN", "IS", "NULL", "TRUE", "FALSE", "CALL", "COPY", "ATTACH", "BEGIN", "ADD",
    "ALTER", "DEFAULT", "DROP", "EXISTS", "OPTIONAL", "PRIMARY", "REL", "NODE",
})

# Workbook status glyphs -> enum. Kept small on purpose: everything else is an edge.
HYP_STATUS = {"🔵": "open", "🟡": "partly_supported", "✅": "confirmed", "❌": "refuted"}

CITE = re.compile(r"\[([FH])(\d+)\]|\b(NP)(\d+)\b")
ROW = re.compile(r"^\|\s*\*{0,2}(NP|H|F)(\d+)\*{0,2}\s*\|(.*)$")
RELATION = re.compile(
    r"\b(SUPERSEDES|REFINES|NARROWS|EXTENDS|OVERTAKEN BY EVENTS)\b.*?\[?F(\d+)\]?", re.I)
RUN_PATH = re.compile(r"(?:^|/)runs/([^/]+)/")


def columns_of(spec: str) -> list[str]:
    return [c.split(":", 1)[0] for c in spec.split()]


def ladybug_type(col: str, spec: str) -> str:
    for c in spec.split():
        if c.split(":", 1)[0] == col:
            t = c.split(":", 1)[1] if ":" in c else "string"
            return {"int": "INT64", "double": "DOUBLE"}.get(t, "STRING")
    return "STRING"


def as_list(v) -> list:
    """A YAML key that may be absent, a scalar, or a list."""
    if v is None or v == "":
        return []
    return list(v) if isinstance(v, list) else [v]


# ── readers ───────────────────────────────────────────────────────────────────────

def as_items(block) -> list[dict]:
    """Normalise a `code:` / `derived:` block to dicts.

    audit-lib.sh writes maps; hand-written and older records write bare paths, often
    with a trailing `# comment`. A path is the one field both forms always have.

    🚨 **A bare string may hold several comma-separated paths**, and ten records in the
    servicedesk corpus do exactly that:

        derived: runs/chains-jul2026/metrics.json, runs/chains-jul2026/metrics-by-tier.json

    Treating that as ONE path produced one `Artifact` keyed on the joined string and one
    `PRODUCED` edge pointing at it. The CSV then carried a quoted two-value cell, `COPY`
    rejected the whole file on that line, and **PRODUCED loaded zero of 257 edges** — a
    single malformed row costing an entire edge type, silently, because the loader
    reported the failure per-file and moved on. Splitting on commas is safe here: no path
    in this vocabulary contains one, and a path that did would have to use the map form.
    """
    if isinstance(block, str):          # `code: path/to/x.py`, not a list
        block = [block]
    out = []
    for item in block or []:
        if isinstance(item, dict):
            out.append(item)
        elif isinstance(item, str):
            for part in item.split("#", 1)[0].split(","):
                part = part.strip()
                if part:
                    out.append({"path": part})
    return out


def read_records(raw: Path) -> list[dict]:
    """Every `<raw-dir>/*.yaml` record directory as a dict."""
    out = []
    for f in sorted(f for f in raw.glob("*.yaml") if not f.name.startswith("probe-00-")):
        try:
            j = subprocess.run(["yq", "-o=json", "-I=0", ".", str(f)],
                               capture_output=True, text=True, timeout=30)
            if j.returncode != 0 or not j.stdout.strip():
                print(f"  ! unparseable, skipped: {f.name}", file=sys.stderr)
                continue
            d = json.loads(j.stdout)
            d["__file"] = f.name
            out.append(d)
        except (subprocess.TimeoutExpired, json.JSONDecodeError):
            print(f"  ! unreadable, skipped: {f.name}", file=sys.stderr)
    return out


#: The 2026-09-01 schema renamed three sections. Hypotheses and Findings merged into
#: **Claims**, and Next probes became **Probes & analyses**. Both spellings are read,
#: newest first, because a workbook written under either must still project.
SECTION_ALIASES = {
    "Findings": ["Claims", "Findings"],
    "Hypotheses": ["Claims", "Hypotheses"],
    "Next probes": ["Probes & analyses", "Next probes"],
}


def section(text: str, name: str) -> str:
    """The body of one `## name` section of the workbook, under any of its names."""
    for candidate in SECTION_ALIASES.get(name, [name]):
        m = re.search(rf"^##\s+{re.escape(candidate)}\s*$(.*?)(?=^##\s|\Z)",
                      text, re.M | re.S)
        if m:
            return m.group(1)
    return ""


def read_workbook(doc: Path | None, raw_dir_name: str = "raw") -> tuple[dict, dict, dict]:
    """Hypotheses, Findings and Questions from the workbook's own sections.

    The workbook is markdown a human maintains, so parse it leniently: a row we do
    not recognise is skipped, never guessed at. The records-directory name is a
    parameter because `Evidence:` lines cite `<raw-dir>/<record>.yaml`; when
    --raw-dir renames the directory, the citation pattern follows it.
    """
    text = doc.read_text(errors="replace") if doc and doc.exists() else ""
    hyp, fnd, qst = {}, {}, {}
    # Two shapes, both read. A finding was a bold paragraph `**F27 — claim.**`; since
    # 2026-09-01 it is a heading `#### F27 — claim`, so that 80-odd findings appear in
    # the document outline and are linkable by id. A workbook in either shape projects.
    for m in re.finditer(
            r"^(?:\*\*|#{2,5}\s*)F(\d+)\s*[-—]\s*(.+?)(?:\*\*|$)"
            r"(.*?)(?=^(?:\*\*|#{2,5}\s*)F\d+\s*[-—]|^##\s|\Z)",
            section(text, "Findings"), re.M | re.S):
        nid = f"F{m.group(1)}"
        fnd[nid] = {
            "id": nid,
            "text": re.sub(r"\s+", " ", re.sub(r"[*`]", "", m.group(2)))[:300],
            "standing": "current",
            "raw": m.group(3),
            "evidence": re.findall(
                rf"{re.escape(raw_dir_name)}/([A-Za-z0-9._-]+\.yaml)", m.group(3)),
        }

    # Hypotheses also appear as blocks, not only as table rows. Since 2026-09-12 a
    # hypothesis carrying a paragraph of state is written as a heading with a
    # `**Where it stands.**` body, exactly like a finding, because a table cell cannot
    # hold a paragraph. Both shapes are read; a workbook in either projects.
    # A block heading is `U5 — the question`; the same id also heads its evidence group
    # as `U5 · members`, which is a pointer and not a second definition, so the dash is
    # required. The body ends at the next heading of any depth: the evidence group is
    # introduced by a plain `### Evidence, grouped by thread`, and a block that ran past
    # it took the following thread's standing glyph as its own.
    for m in re.finditer(
            r"^#{2,5}\s*([HU])(\d+)\s*[-—]\s+(.+?)$(.*?)"
            r"(?=^#{1,5}\s|\Z)",
            section(text, "Claims") or text, re.M | re.S):
        nid, body = f"{m.group(1)}{m.group(2)}", m.group(4)
        # First glyph as it appears in the text, not first in HYP_STATUS: a thread whose
        # halves sit at different states carries several, and the leading one is its
        # headline. Iterating the dict would return whichever key happens to come first.
        glyph = next((c for c in body if c in HYP_STATUS), "")
        hyp[nid] = {
            "id": nid,
            "text": re.sub(r"\s+", " ", re.sub(r"[*`]", "", m.group(3)))[:300],
            "status": HYP_STATUS.get(glyph, "open"),
            "raw": body,
            "evidence": re.findall(r"\bF(\d+)\b", body),
        }

    for name, bucket, kind in (("Hypotheses", hyp, "H"), ("Next probes", qst, "NP")):
        for line in section(text, name).splitlines():
            m = ROW.match(line)
            if not m or m.group(1) != kind:
                continue
            nid, body = f"{kind}{m.group(2)}", m.group(3)
            glyph = next((g for g in HYP_STATUS if g in body), "")
            cells = [c.strip() for c in body.split("|")]
            tail = next((c for c in reversed(cells) if c), "")   # trailing "|" leaves ""
            bucket[nid] = {
                "id": nid,
                "text": re.sub(r"\s+", " ", re.sub(r"[*`]", "", cells[0]))[:300],
                "status": HYP_STATUS.get(glyph, "open"),
                "raw": body,
                # A Hypotheses row's last cell is its evidence column; an em-dash there
                # means nothing has been recorded as moving this hypothesis.
                "evidence": re.findall(r"\bF(\d+)\b", tail),
                # A probe row's `settles` cell names the claim it moves. It was the
                # second cell; the 2026-09-01 schema inserts a `status` column before
                # it, so both positions are read — a row cannot mean two things, and
                # scanning both costs nothing.
                "settles": re.findall(
                    r"\bH(\d+)\b", " ".join(cells[1:3])),
            }
    return hyp, fnd, qst


def read_runs(runs_dir: Path) -> dict[str, dict]:
    """One Run per `<runs-dir>/<run-id>/` that has a config.

    `code_version` decides whether two numbers are comparable, and it is the field
    nobody writes by hand — so read it when present and leave it empty and visible
    when not, rather than substituting the per-file sha, which is a different thing.
    """
    runs: dict[str, dict] = {}
    for d in sorted(runs_dir.glob("*")):
        if not d.is_dir():
            continue
        cfg_path = next((p for p in (d / "config.yaml", d / "config.json")
                         if p.exists()), None)
        cfg: dict = {}
        if cfg_path:
            try:
                j = subprocess.run(["yq", "-o=json", "-I=0", ".", str(cfg_path)],
                                   capture_output=True, text=True, timeout=30)
                if j.returncode == 0 and j.stdout.strip():
                    loaded = json.loads(j.stdout)
                    cfg = loaded if isinstance(loaded, dict) else {}
            except (subprocess.TimeoutExpired, json.JSONDecodeError):
                pass
        runs[d.name] = {
            "id": d.name,
            "path": f"{runs_dir.name}/{d.name}",
            "config": json.dumps(cfg, sort_keys=True)[:600] if cfg else "",
            "code_version": str(cfg.get("code_version", "")),
            "data_epoch": str(cfg.get("data_epoch") or cfg.get("window") or ""),
            "metrics": "yes" if (d / "metrics.json").exists() else "",
            "__code": [c for c in (cfg.get("code"), cfg.get("rule")) if isinstance(c, str)],
            "__has_config": cfg_path is not None,
        }
    return runs


def read_judgements(inv: Path) -> list[dict]:
    """Judgements from the store's append-only `audit_decision` table.

    The graph absorbs `audit_lineage` as DERIVES edges. `audit_decision` is the other
    invariant table and has no graph form without this: the record of what was chosen,
    against what alternative, and why. Without it the graph can say what is believed
    and never why the work was done this way.
    """
    out: list[dict] = []
    for db in sorted(inv.glob("*.db")) + sorted(inv.glob("*.sqlite")) + \
            sorted(inv.glob("*.sqlite3")):
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            if not con.execute("SELECT name FROM sqlite_master WHERE type='table' "
                               "AND name='audit_decision'").fetchone():
                con.close()
                continue
            rows = con.execute(
                "SELECT at, who, table_name, row_key, field, old_value, new_value, "
                "why, evidence FROM audit_decision ORDER BY at, rowid").fetchall()
            con.close()
        except sqlite3.Error as e:
            print(f"  ! store unreadable, skipped: {db.name} ({e})", file=sys.stderr)
            continue
        for i, (at, who, tbl, key, field, old, new, why, ev) in enumerate(rows, 1):
            out.append({
                "id": f"J{i}", "at": at or "", "who": who or "",
                "what": f"{tbl}:{key}" + (f".{field}" if field else ""),
                "chose": str(new or "")[:300], "instead_of": str(old or "")[:300],
                "why": re.sub(r"\s+", " ", str(why or ""))[:400],
                "evidence": str(ev or "")[:300],
                "__target": key or "",
            })
    return out


# ── the domain half ───────────────────────────────────────────────────────────────

DOMAIN_CONTRACT = """
A domain module is a plain Python file with NO database driver imported, so the model
stays testable without an engine and the engine choice stays reversible. It exports
five things:

    NODES = {"Ticket": ("number", "number opened_at priority"), ...}
        label -> (primary key column, space-separated columns; ":int" / ":double" as
        in the fixed vocabulary). A label colliding with a fixed label or a Cypher
        reserved word is rejected at import.

    EDGES = {"ABOUT_CI": ("Ticket", "CI"), ...}
        edge type -> (from label, to label). Both must be domain labels.

    def nodes() -> Iterable[tuple[str, dict]]
        ("Ticket", {"number": "INC1", ...}) — one per node.

    def edges() -> Iterable[tuple[str, str, str, dict]]
        ("ABOUT_CI", "INC1", "srv-01", {}) — (type, from key, to key, properties).

    def bridge() -> Iterable[tuple[str, str, str, str]]
        ("ABOUT", "F27", "Ticket", "INC1") — (bridge type, claim-layer node id,
        domain label, domain key). This is the ONLY place the two halves touch, so
        it is the one function to read when asking what couples them.

    COHORTS = {"sd-cohort-24mo": "first_group in service_desk_aliases, 24 months"}
        OPTIONAL. Populations this module's INCLUDES edges point at. A Cohort is a
        claim-layer node, but its DEFINITION is domain knowledge, so it is declared
        here. Without this a module can reference a cohort it cannot create, and the
        INCLUDES edge dangles.
""".strip()


def load_domain(path: Path):
    spec = importlib.util.spec_from_file_location("work_graph_domain", path)
    if not spec or not spec.loader:
        raise SystemExit(f"cannot import domain module: {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for attr in ("NODES", "EDGES", "nodes", "edges", "bridge"):
        if not hasattr(mod, attr):
            raise SystemExit(f"domain module {path} has no {attr!r}.\n\n{DOMAIN_CONTRACT}")
    if bad := [l for l in mod.NODES if l in NODES]:
        raise SystemExit(
            f"domain module claims fixed labels {bad}. The claim and provenance layers "
            f"are reserved: rename yours. This is not pedantry — one investigation here "
            f"already has a domain 'Decision' meaning a routing hop, which is not the "
            f"claim layer's 'Judgement' meaning a choice about the work.")
    if bad := [l for l in mod.NODES if l.upper() in CYPHER_RESERVED]:
        raise SystemExit(
            f"domain labels {bad} are Cypher reserved words — `MATCH (n:Group)` is a "
            f"parse error on Ladybug 0.20.1. Rename the label (AssignmentGroup) rather "
            f"than backticking every query that will ever touch it.")
    return mod


# ── build ─────────────────────────────────────────────────────────────────────────

# A run whose derived artifacts live under <runs-dir>/<id>/ is IN that run. Built from
# the runs dir name so `--runs-dir data` produces `data/` matchers, not hardcoded `runs/`.
def _run_path_re(runs_dir_name: str) -> re.Pattern:
    return re.compile(rf"(?:^|/){re.escape(runs_dir_name)}/([^/]+)/")

RUN_PATH = _run_path_re("runs")     # default; build() re-binds when --runs-dir differs

def build(inv: Path, domain=None, raw_dir: Path | None = None,
          runs_dir: Path | None = None, workbook_glob: str = "INVESTIGATION-*.md") \
        -> tuple[dict, list, list, dict, list]:
    """Return (nodes, edges, problems, domain_labels, dangling).

    `edges` holds only edges whose both endpoints exist; `dangling` holds the rest.
    Nodes are keyed (label, id).
    """
    global RUN_PATH
    raw_dir = raw_dir or inv / "raw"
    runs_dir = runs_dir or inv / "runs"
    RUN_PATH = _run_path_re(runs_dir.name)
    doc = next(iter(sorted(inv.glob(workbook_glob))), None)
    if doc is None and workbook_glob != "INVESTIGATION-*.md":
        raise SystemExit(f"no workbook matches {workbook_glob!r} under {inv}")
    hyp, fnd, qst = read_workbook(doc, raw_dir_name=raw_dir.name)
    records = read_records(raw_dir)
    runs = read_runs(runs_dir)
    judgements = read_judgements(inv)

    nodes: dict[tuple[str, str], dict] = {}
    edges: list[dict] = []
    problems: list[str] = []
    produced: set[str] = set()

    def add(label, nid, **p):
        nodes.setdefault((label, str(nid)), {"id": str(nid), **p})

    def link(rel, src_label, src, dst_label, dst, **p):
        produced.add(rel)
        edges.append({"rel": rel, "src_label": src_label, "src": str(src),
                      "dst_label": dst_label, "dst": str(dst), **p})

    for d in hyp.values():
        add("Hypothesis", d["id"], text=d["text"], status=d["status"])
    for d in fnd.values():
        add("Finding", d["id"], text=d["text"], standing="current")
    for d in qst.values():
        add("Question", d["id"], text=d["text"], status=d["status"])
    for r in runs.values():
        add("Run", r["id"], **{k: v for k, v in r.items() if not k.startswith("__")})
        if not r["__has_config"]:
            problems.append(f"run without config.yaml: runs/{r['id']}")

    for d in hyp.values():
        for f in d["evidence"]:
            link("MOVED_BY", "Hypothesis", d["id"], "Finding", f"F{f}")
    for d in qst.values():
        for h in d["settles"]:
            link("RAISES", "Question", d["id"], "Hypothesis", f"H{h}")
    for d in fnd.values():
        for ev in d["evidence"]:
            link("CITES", "Finding", d["id"], "ProbeRecord", Path(ev).stem)
        for rel, target in RELATION.findall(d["raw"]):
            rel = rel.upper().replace("OVERTAKEN BY EVENTS", "OVERTAKEN_BY")
            if f"F{target}" != d["id"]:
                link(rel, "Finding", d["id"], "Finding", f"F{target}")
                # The property records the standing of the OLD finding, so it is the
                # passive form: F50 SUPERSEDES F39 leaves F39 `superseded`, not
                # `supersedes`. The active word there reads as if F39 did the
                # superseding, which is backwards.
                standing = {"SUPERSEDES": "superseded",
                            "OVERTAKEN_BY": "overtaken_by_events"}.get(rel)
                if standing and ("Finding", f"F{target}") in nodes:
                    nodes[("Finding", f"F{target}")]["standing"] = standing

    for r in records:
        rid = r.get("record") or Path(r["__file"]).stem
        # A record belongs to the run its log or artifacts landed in. That hop was
        # missing from the chain: without it a number cannot be traced to the config
        # and code version that produced it.
        paths = [str(r.get("log", ""))] + \
            [str(a.get("path", "")) for a in as_items(r.get("derived"))]
        run_id = next((m.group(1) for p in paths if (m := RUN_PATH.search(p))), "")
        add("ProbeRecord", rid,
            type=r.get("type", ""), timestamp=r.get("timestamp", ""),
            verdict=r.get("verdict", ""),
            key_evidence=re.sub(r"\s+", " ", str(r.get("key_evidence", "")))[:300],
            command=str(r.get("command", ""))[:300],
            exit_code=r.get("exit_code", ""), output_kind=r.get("output_kind", ""),
            file=r["__file"], run=run_id)

        if str(r.get("verdict", "")).upper().startswith("TODO"):
            problems.append(f"unfilled verdict: {r['__file']}")
        if run_id and ("Run", run_id) in nodes:
            link("IN_RUN", "ProbeRecord", rid, "Run", run_id)

        # Both blocks appear two ways in the wild: as maps written by audit-lib.sh, and
        # as bare path strings (often with a trailing `# comment`) in hand-written or
        # older records. Accept both rather than dropping half the corpus.
        for c in as_items(r.get("code")):
            key = (c.get("sha256") or "")[:12] or c.get("path", "")
            if key:
                add("Code", key, path=c.get("path", ""), sha256=c.get("sha256", ""),
                    stored=c.get("stored", ""), version=str(c.get("version", "")))
                link("RAN", "ProbeRecord", rid, "Code", key)
        for a in as_items(r.get("derived")):
            path = a.get("path", "")
            if not path:
                continue
            m = RUN_PATH.search(path)
            add("Artifact", path, path=path, bytes=a.get("bytes", ""),
                sha256=a.get("sha256", ""), run=m.group(1) if m else "")
            link("PRODUCED", "ProbeRecord", rid, "Artifact", path)
            if m and ("Run", m.group(1)) in nodes:
                link("WROTE", "Run", m.group(1), "Artifact", path)

        # Explicit keys a record may carry. `bears_on` is the edge prose alone could
        # never produce — measured zero across a 64-record investigation — so it is a
        # field rather than a hoped-for citation in the claim.
        for h in as_list(r.get("bears_on")):
            link("BEARS_ON", "ProbeRecord", rid, "Hypothesis", str(h),
                 verdict=r.get("verdict", ""))
        for other in as_list(r.get("invalidates")):
            link("INVALIDATES", "ProbeRecord", rid, "ProbeRecord", str(other))
        coh = r.get("cohort")
        if isinstance(coh, dict) and coh.get("id"):
            add("Cohort", coh["id"], definition=str(coh.get("definition", ""))[:300],
                n=coh.get("n", ""), source=r["__file"])
            link("OVER", "ProbeRecord", rid, "Cohort", coh["id"])
        elif isinstance(coh, str) and coh:
            add("Cohort", coh, definition="", n="", source=r["__file"])
            link("OVER", "ProbeRecord", rid, "Cohort", coh)

        # The citations already in the prose. This is the whole trick: the claim-layer
        # edges exist in the corpus today, unparsed.
        seen = set()
        for a, b, c, e in CITE.findall(f"{r.get('claim','')} {r.get('key_evidence','')}"):
            kind, num = (a, b) if a else (c, e)
            tgt = f"{kind}{num}"
            if tgt in seen:
                continue
            seen.add(tgt)
            if kind == "H":
                link("BEARS_ON", "ProbeRecord", rid, "Hypothesis", tgt,
                     verdict=r.get("verdict", ""))
            elif kind == "F":
                # A record mentioning [F27] REFERS TO it. The reverse edge, CITES,
                # comes from the finding's own Evidence: line — the finding decides
                # what supports it, not the record.
                link("REFERS_TO", "ProbeRecord", rid, "Finding", tgt)
            elif kind == "NP":
                link("ANSWERS", "ProbeRecord", rid, "Question", tgt)

    for r in runs.values():
        for c in r["__code"]:
            if ("Code", c) not in nodes:
                # A run naming code no record ran is still a real edge; the Code node
                # is keyed by path here rather than by sha, and that difference is
                # itself worth seeing.
                add("Code", c, path=c, sha256="", stored="", version="")
            link("USED_CODE", "Run", r["id"], "Code", c)

    for j in judgements:
        add("Judgement", j["id"], **{k: v for k, v in j.items()
                                     if not k.startswith("__")})
        # A judgement about the work points at a node when its row_key names one;
        # otherwise it stands alone and its `what` says what it was about.
        for label in ("Finding", "Hypothesis", "Question", "ProbeRecord", "Run"):
            if (label, j["__target"]) in nodes:
                link("JUDGED", "Judgement", j["id"], label, j["__target"])
                break
        for f in re.findall(r"\bF(\d+)\b", j["evidence"]):
            link("BECAUSE", "Judgement", j["id"], "Finding", f"F{f}")

    domain_labels: dict[str, tuple[str, str]] = {}
    if domain is not None:
        domain_labels = dict(domain.NODES)
        # A Cohort is a claim-layer node whose definition is domain knowledge, so the
        # module declares it and the claim layer owns the label.
        for cid, definition in getattr(domain, "COHORTS", {}).items():
            add("Cohort", cid, definition=str(definition)[:300], n="",
                source=str(getattr(domain, "__file__", "domain module")))
        for label, props in domain.nodes():
            add(label, props[domain.NODES[label][0]], **props)
        for etype, src, dst, props in domain.edges():
            s, d = domain.EDGES[etype]
            link(etype, s, src, d, dst, **props)
        for btype, claim_id, dlabel, dkey in domain.bridge():
            if btype not in BRIDGE:
                problems.append(f"unknown bridge edge {btype!r}; "
                                f"the bridge is fixed: {', '.join(BRIDGE)}")
                continue
            link(btype, BRIDGE[btype][0], claim_id, dlabel, dkey)

    # Dangling citations are a real defect: the record cites a finding the workbook
    # does not have, so a reader following the citation lands nowhere. An edge with a
    # missing endpoint is not an edge — it is a broken citation, so it is partitioned
    # out here rather than loaded. It still reaches disk, as `dangling_edges.csv`:
    # dropping it silently would hide the defect the check exists to find.
    kept, dangling = [], []
    for e in edges:
        missing = [f"{e[f'{s}_label']} {e[s]}" for s in ("src", "dst")
                   if (e[f"{s}_label"], e[s]) not in nodes]
        if missing:
            dangling.append(e)
            for m in missing:
                problems.append(f"dangling {e['rel']}: {m} cited but not defined "
                                f"in the workbook")
        else:
            kept.append(e)
    edges = kept

    # An edge whose two ends are both populated and which still has no rows is a link
    # the discipline calls for that nothing writes. It reads as "(none found)", which
    # is indistinguishable from "none in this investigation" — so name it, and name
    # what would produce it. Absences with an unpopulated end are ordinary and silent.
    facts = {
        "questions": bool(qst), "hypotheses": bool(hyp), "findings": bool(fnd),
        "records": bool(records), "runs": bool(runs),
        "code": any(as_items(r.get("code")) for r in records),
        "derived": any(as_items(r.get("derived")) for r in records),
        "store": bool(judgements),
    }
    for rel, (_, _, producer, needs) in EDGES.items():
        if rel not in produced and needs and all(facts[f] for f in needs):
            have = " and ".join(needs)
            problems.append(f"unwritten edge {rel}: this corpus has {have}, and "
                            f"nothing connects them. Produced by: {producer}")
    return nodes, edges, problems, domain_labels, dangling


# ── export ────────────────────────────────────────────────────────────────────────

def flat(v) -> str:
    """One CSV cell, on one line.

    🚨 The CSV reader rejects a newline inside a quoted field outright ("Quoted
    newlines are not supported") unless the whole file is read with `parallel=false`.
    Audit prose is full of them. Flattening at export keeps the file loadable by any
    reader, which matters because the CSVs — not the database — are the artifact.
    """
    return re.sub(r"\s*\n\s*", " ⏎ ", str("" if v is None else v)).strip()


def all_node_specs(domain_labels: dict) -> dict[str, tuple[str, str]]:
    return {**{l: (k, c) for l, (k, c, _) in NODES.items()}, **domain_labels}


def write_csvs(nodes, edges, out: Path, domain_labels: dict, dangling: list) -> None:
    out.mkdir(parents=True, exist_ok=True)
    by_label: dict[str, list] = {}
    for (label, _), props in nodes.items():
        by_label.setdefault(label, []).append(props)

    for label, (_, spec) in all_node_specs(domain_labels).items():
        cols = columns_of(spec)
        with (out / f"nodes_{label}.csv").open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            w.writeheader()
            for r in sorted(by_label.get(label, []), key=lambda x: str(x.get("id", ""))):
                w.writerow({c: flat(r.get(c, "")) for c in cols})

    by_rel: dict[str, list] = {}
    for e in edges:
        by_rel.setdefault(e["rel"], []).append(e)
    # Every declared edge type gets a file, empty-but-declared when unused: a missing
    # file reads as "no such relationship", an empty one reads as "none found".
    for rel in list(EDGES) + list(BRIDGE) + \
            [r for r in by_rel if r not in EDGES and r not in BRIDGE]:
        rows = by_rel.get(rel, [])
        props = sorted({k for r in rows for k in r} -
                       {"rel", "src_label", "dst_label", "src", "dst"})
        # 🚨 `start` and `end` MUST lead the file, in that order. The engine's relationship
        # COPY is positional: column 1 is FROM, column 2 is TO, and the header names
        # are ignored entirely. Sorting the field names — which this script used to do
        # — puts `dst` before `src` alphabetically and loads every edge BACKWARDS with
        # no error. Measured on 0.11.3.
        cols = ["start", "end"] + props
        with (out / f"edges_{rel}.csv").open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            w.writeheader()
            for r in rows:
                w.writerow({"start": flat(r["src"]), "end": flat(r["dst"]),
                            **{c: flat(r.get(c, "")) for c in props}})
        # Which label pair each row connects. A polymorphic edge's endpoints differ
        # row to row; the loader needs this, and so does a human reading the CSV.
        pairs: dict[tuple[str, str], int] = {}
        for r in rows:
            pairs[(r["src_label"], r["dst_label"])] = \
                pairs.get((r["src_label"], r["dst_label"]), 0) + 1
        if len(pairs) > 1 or rel in BRIDGE:
            with (out / f"edges_{rel}.pairs.csv").open("w", newline="") as fh:
                w = csv.writer(fh)
                w.writerow(["src_label", "dst_label", "n"])
                for (s, d), n in sorted(pairs.items()):
                    w.writerow([s, d, n])

    # Broken citations reach disk too. They cannot be loaded — one endpoint does not
    # exist — but a defect that leaves no artifact is a defect you rediscover.
    with (out / "dangling_edges.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["rel", "src_label", "src", "dst_label", "dst"])
        for e in dangling:
            w.writerow([e["rel"], e["src_label"], e["src"], e["dst_label"], e["dst"]])

    (out / "schema.cypher").write_text(schema_cypher(nodes, edges, domain_labels))


def rel_pairs(edges, present: set[str]) -> dict[str, list[tuple[str, str]]]:
    """The (from, to) label pairs each edge type actually connects."""
    out: dict[str, set[tuple[str, str]]] = {}
    for e in edges:
        out.setdefault(e["rel"], set()).add((e["src_label"], e["dst_label"]))
    return {rel: sorted(p for p in pairs if p[0] in present and p[1] in present)
            for rel, pairs in out.items()}


def schema_cypher(nodes, edges, domain_labels: dict) -> str:
    present = {label for (label, _) in nodes}
    pairs = rel_pairs(edges, present)
    lines = ["// Generated by work-graph.py. The claim and provenance layers are fixed;",
             "// the domain layer comes from the project's own module.", ""]
    for label, (key, spec) in all_node_specs(domain_labels).items():
        body = ", ".join(f"`{c}` {ladybug_type(c, spec)}" for c in columns_of(spec))
        tag = "   // domain" if label in domain_labels else ""
        lines.append(f"CREATE NODE TABLE IF NOT EXISTS `{label}`"
                     f"({body}, PRIMARY KEY (`{key}`));{tag}")
    lines.append("")
    for rel in list(EDGES) + list(BRIDGE):
        p = pairs.get(rel, [])
        if not p:
            src = (EDGES | BRIDGE)[rel][0]
            lines.append(f"// `{rel}` has no rows in this corpus: "
                         f"(:{src})-[:{rel}]->(:?)")
            continue
        body = ", ".join(f"FROM `{s}` TO `{d}`" for s, d in p)
        tag = "   // bridge" if rel in BRIDGE else ""
        lines.append(f"CREATE REL TABLE IF NOT EXISTS `{rel}`({body});{tag}")
    return "\n".join(lines) + "\n"


# ── engine ───────────────────────────────────────────────────────────────────────
# LadybugDB (default) and Kuzu 0.11 share one API surface — Database/Connection,
# execute(), COPY with parallel=false — which is why one loader serves both. The
# differences are two: the driver module name, and the stored shape, a single FILE
# (Ladybug 0.20, like Kuzu 0.11's older releases) versus a DIRECTORY (Kuzu 0.11).

ENGINES = {
    "ladybug": __import__("types").SimpleNamespace(module="ladybug", single_file=True),
    "kuzu":    __import__("types").SimpleNamespace(module="kuzu",    single_file=False),
}

def _open_db(db: Path):
    """Open an existing graph db, choosing the driver by path suffix.

    `--query` without an engine flag must still work against whatever is on disk:
    `.kuzu` paths load Kuzu, everything else Ladybug. An ImportError from either is
    a missing wheel, reported as that — not as a bad query.
    """
    module = "kuzu" if db.name == "kuzu" or db.name.endswith(".kuzu") else "ladybug"
    try:
        eng = __import__(module)
    except ImportError as e:
        raise ImportError(f"'{module}' is not installed (`pip install {module}`); "
                          f"needed to open {db}") from e
    return eng.Connection(eng.Database(str(db)))

def drop_db(path: Path, single_file: bool = True) -> None:
    """Delete a graph db and its sidecars. Ladybug 0.20 stores a single FILE;
    Kuzu 0.11 stores a DIRECTORY. Each has a failure mode the other does not:
    rmtree on a file does nothing, unlink on a directory raises IsADirectoryError,
    and `ignore_errors` swallows both — so a rebuild flag silently becomes an
    append, and the symptom is a "duplicated primary key" on a store that
    provably has no duplicates. Never pass ignore_errors where the error IS the
    signal.
    """
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()
    for suffix in (".wal", ".lock", ".shadow"):
        side = Path(str(path) + suffix)
        if side.exists():
            side.unlink()


def edge_columns(imp: Path, rel: str) -> list[str]:
    f = imp / f"edges_{rel}.csv"
    if not f.exists():
        return []
    with f.open() as fh:
        return next(csv.reader(fh), [])


def guard_existing_store(db: Path, about_to_write: set[str], engine: str,
                         force: bool) -> None:
    """Refuse to destroy a store that holds layers this run does not produce.

    🚨 **This function exists because the absence of it cost a corpus.** On
    2026-09-01 `--ladybug` was pointed at an investigation's store of record to add
    a claim layer. It rebuilds, so it deleted the database first: 16.5 M domain
    nodes, 2.37 GB, gone in a second. The claim layer it then wrote was correct,
    which is the worst possible outcome — the run reported success.

    A rebuild is a legitimate operation and stays available. It is now something you
    ask for, not something you get by omitting a flag. Recovery was a backup; there
    is not always a backup.
    """
    if not db.exists() or force:
        return
    spec = ENGINES[engine]
    try:
        mod = __import__(spec.module)
        conn = mod.Connection(mod.Database(str(db)))
        res = conn.execute("CALL show_tables() RETURN *")
        names = res.get_column_names()
        held = set()
        while res.has_next():
            row = dict(zip(names, res.get_next()))
            if str(row.get("type", "")).upper().startswith("NODE"):
                held.add(row.get("name"))
        del conn
    except Exception:
        return                      # unreadable or empty: nothing to protect

    strangers = sorted(held - about_to_write)
    if not strangers:
        return
    raise SystemExit(
        f"REFUSING to rebuild {db}\n"
        f"  It already holds {len(strangers)} node table(s) this run does not "
        f"produce:\n    {', '.join(strangers[:12])}"
        f"{' …' if len(strangers) > 12 else ''}\n"
        "  Loading here DELETES them — this is a rebuild, not an append.\n"
        "  If that is what you want, pass --force. If you meant to ADD the claim\n"
        "  layer to a store that already has a domain, load the CSVs with\n"
        "  create-if-absent + COPY instead, and assert the domain survived.")


def load_db(imp: Path, db: Path, nodes, edges, domain_labels: dict,
            engine: str = "ladybug", force: bool = False) -> dict:
    """Load the CSVs into LadybugDB or Kuzu. One body, two driver names.

    **This rebuilds.** The database is deleted and recreated from the CSVs; any
    table not in this run's output is destroyed. `guard_existing_store` refuses
    when that would lose something, unless `--force`.
    """
    spec = ENGINES[engine]
    mod = __import__(spec.module)

    guard_existing_store(db, {label for (label, _) in nodes}, engine, force)
    drop_db(db, single_file=spec.single_file)
    conn = mod.Connection(mod.Database(str(db)))
    counts: dict[str, int] = {}
    present = {label for (label, _) in nodes}

    def one(q):
        r = conn.execute(q)
        return r.get_next()[0] if r.has_next() else 0

    for label, (key, spec) in all_node_specs(domain_labels).items():
        body = ", ".join(f"`{c}` {ladybug_type(c, spec)}" for c in columns_of(spec))
        conn.execute(f"CREATE NODE TABLE IF NOT EXISTS `{label}`"
                     f"({body}, PRIMARY KEY (`{key}`))")
        f = imp / f"nodes_{label}.csv"
        if f.exists():
            # parallel=false is the option that matters: without it the engine refuses any
            # quoted newline. flat() already strips them, so this is belt and braces
            # for a CSV someone edited by hand.
            conn.execute(f'COPY `{label}` FROM "{f}" (header=true, quote=\'"\', escape=\'"\', parallel=false)')
            counts[f"node:{label}"] = one(f"MATCH (n:`{label}`) RETURN count(*)")

    pairs = rel_pairs(edges, present)
    domain_rels = [r for r in pairs if r not in EDGES and r not in BRIDGE]
    for rel in list(EDGES) + list(BRIDGE) + domain_rels:
        p = pairs.get(rel, [])
        if not p:
            # 🚨 An edge type with no table is not an empty result — it is a binding
            # error, so `MATCH ()-[:BEARS_ON]->()` FAILS rather than returning zero
            # rows, and a query joining several relations fails if any one of them
            # was never created. So declare every fixed-endpoint edge whether or not
            # it has rows. A `*` edge cannot be declared without rows: its endpoint
            # labels are only known from the rows themselves.
            if rel not in EDGES and rel not in BRIDGE:
                continue                   # a domain edge with no rows declares nothing
            src, dst = (EDGES | BRIDGE)[rel][:2]
            if dst == "*" or src not in present or dst not in present:
                continue
            conn.execute(f"CREATE REL TABLE IF NOT EXISTS `{rel}`"
                         f"(FROM `{src}` TO `{dst}`)")
            counts[f"edge:{rel}"] = 0
            continue
        cols = edge_columns(imp, rel)
        if cols[:2] != ["start", "end"]:
            raise SystemExit(f"{rel}: edge CSV must lead with start,end — got "
                             f"{cols[:2]}. COPY is positional and would load "
                             f"every row backwards.")
        body = ", ".join(f"FROM `{s}` TO `{d}`" for s, d in p)
        body += "".join(f", `{c}` STRING" for c in cols[2:])
        conn.execute(f"CREATE REL TABLE IF NOT EXISTS `{rel}`({body})")
        conn.execute(f'COPY `{rel}` FROM "{imp / f"edges_{rel}.csv"}" '
                     f'(header=true, quote=\'"\', escape=\'"\', parallel=false)')
        counts[f"edge:{rel}"] = one(f"MATCH ()-[r:`{rel}`]->() RETURN count(*)")
    return counts


def conformance(conn, nodes, edges) -> list[dict]:
    """Re-derive, in the engine, counts the CSVs already state.

    A graph agreeing with itself proves nothing; agreeing with the corpus it came from
    is the test. Two views of one corpus disagreeing is what catches the defect
    neither view reports on its own.
    """
    want_nodes: dict[str, int] = {}
    for (label, _) in nodes:
        want_nodes[label] = want_nodes.get(label, 0) + 1
    want_edges: dict[str, int] = {}
    for e in edges:
        want_edges[e["rel"]] = want_edges.get(e["rel"], 0) + 1

    out = []
    for label, n in sorted(want_nodes.items()):
        r = conn.execute(f"MATCH (n:`{label}`) RETURN count(*)")
        got = r.get_next()[0] if r.has_next() else 0
        out.append({"check": f"nodes {label}", "got": got, "expect": n,
                    "agree": got == n})
    for rel, n in sorted(want_edges.items()):
        try:
            r = conn.execute(f"MATCH ()-[x:`{rel}`]->() RETURN count(*)")
            got = r.get_next()[0] if r.has_next() else 0
        except Exception:
            got = "not loaded"
        out.append({"check": f"edges {rel}", "got": got, "expect": n,
                    "agree": got == n})
    return out


# ── main ──────────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("investigation", type=Path,
                    help="the working folder (its name still identifies the "
                         "investigation in output)")
    ap.add_argument("-o", "--out", type=Path, default=None,
                    help="CSV directory; default <inv>/runs/work-graph/import")
    ap.add_argument("--raw-dir", type=Path, default=None,
                    help="records directory; default <inv>/raw")
    ap.add_argument("--runs-dir", type=Path, default=None,
                    help="derived-runs directory; default <inv>/runs")
    ap.add_argument("--workbook", default="INVESTIGATION-*.md",
                    help="glob for the workbook; default INVESTIGATION-*.md")
    ap.add_argument("--db", type=Path, default=None,
                    help="engine database path; default <out>/../<engine>")
    ap.add_argument("--domain", type=Path, default=None,
                    help="python module emitting the domain layer "
                         "(see --domain-contract)")
    ap.add_argument("--domain-contract", action="store_true",
                    help="print what a domain module must export, and exit")
    ap.add_argument("--check-only", action="store_true", help="report and write nothing")
    ap.add_argument("--force", action="store_true",
                    help="allow a rebuild to delete tables this run does not produce. "
                         "Required when the target store holds a domain layer — "
                         "loading is a REBUILD, not an append")
    ap.add_argument("--ladybug", action="store_true",
                    help="load the CSVs into an embedded LadybugDB database beside them")
    ap.add_argument("--kuzu", dest="kuzu", action="store_true",
                    help="load the CSVs into a legacy embedded Kuzu 0.11 db instead")
    ap.add_argument("--query", help="run one Cypher query against the loaded database "
                                    "(engine chosen by --ladybug/--kuzu/--db suffix)")
    a = ap.parse_args()

    if a.ladybug and a.kuzu:
        ap.error("--ladybug and --kuzu are exclusive")

    if a.domain_contract:
        print(DOMAIN_CONTRACT)
        return 0

    inv = a.investigation.resolve()
    # A --db that does not exist (yet) is resolved against the investigation like the
    # directory flags. An EXISTING one is honoured exactly as given — the query-only
    # call passes the db path itself as the investigation (e.g. `runs/work-graph
    # --db runs/work-graph/ladybug`), so re-anchoring an existing, correct path
    # would corrupt it. Existence is the discriminator.
    raw_dir = (inv / a.raw_dir).resolve() if a.raw_dir else None
    runs_dir = (inv / a.runs_dir).resolve() if a.runs_dir else None
    out = a.out or inv / "runs" / "work-graph" / "import"
    if a.out:
        out = a.out if a.out.is_absolute() else (inv / a.out)
    engine = "kuzu" if a.kuzu else "ladybug"
    if a.db:
        db = a.db if (a.db.is_absolute() or a.db.exists()) else (inv / a.db)
    else:
        db = out.parent / engine
    if a.query and not a.db:
        # Query-only with no --db: the investigation argument may itself be the db
        # path or the directory holding it, so probe the usual spots in order.
        for cand in (inv / "ladybug", inv / "kuzu", inv.parent / "ladybug",
                     inv.parent / "kuzu"):
            if cand.exists():
                db = cand
                break

    if a.query:
        try:
            res = _open_db(db).execute(a.query)
        except (RuntimeError, ImportError) as e:
            # The binder message names the missing table, which is the whole
            # diagnosis; a bare traceback hides it behind the driver's call stack.
            print(f"query failed: {e}", file=sys.stderr)
            return 1
        print(" | ".join(res.get_column_names()))
        n = 0
        while res.has_next() and n < 100:
            # Render NULL explicitly. An empty cell is indistinguishable from a value
            # that failed to format, and a silently blank column is the exact defect
            # this discipline keeps recording.
            print(" | ".join("null" if v is None else str(v)[:80]
                             for v in res.get_next()))
            n += 1
        print(f"({n} rows)")
        return 0

    if not a.raw_dir and not (inv / "raw").is_dir():
        print(f"no raw/ under {inv} — pass --raw-dir if your records live elsewhere",
              file=sys.stderr)
        return 2

    nodes, edges, problems, domain_labels, dangling = build(
        inv, load_domain(a.domain) if a.domain else None,
        raw_dir=raw_dir, runs_dir=runs_dir, workbook_glob=a.workbook)

    counts: dict[str, int] = {}
    for (label, _) in nodes:
        counts[label] = counts.get(label, 0) + 1
    rel_counts: dict[str, int] = {}
    for e in edges:
        rel_counts[e["rel"]] = rel_counts.get(e["rel"], 0) + 1

    print(f"=== {inv.name}")
    for group, labels in (("claim", CLAIM_LAYER), ("provenance", PROVENANCE_LAYER),
                          ("domain", domain_labels)):
        if not labels:
            continue
        print(f"  -- {group} layer")
        for label in labels:
            print(f"  {label:<14} {counts.get(label, 0):>7}")
    print("  --")
    for rel in list(EDGES) + list(BRIDGE):
        n = rel_counts.get(rel, 0)
        print(f"  {rel:<14} {n:>7}" + ("" if n else "   (none found)"))

    rc = 0
    if not a.check_only:
        write_csvs(nodes, edges, out, domain_labels, dangling)
        print(f"\n  wrote {len(nodes)} nodes / {len(edges)} edges -> {out}")
        if dangling:
            print(f"  {len(dangling)} broken citation(s) held out of the graph "
                  f"-> {out.name}/dangling_edges.csv")
        if a.ladybug or a.kuzu:
            loaded = load_db(out, db, nodes, edges, domain_labels,
                             engine=engine, force=a.force)
            conn = _open_db(db)
            checks = conformance(conn, nodes, edges)
            print(f"  loaded "
                  f"{sum(v for k, v in loaded.items() if k.startswith('node'))} nodes / "
                  f"{sum(v for k, v in loaded.items() if k.startswith('edge'))} edges "
                  f"-> {db}")
            if bad := [c for c in checks if not c["agree"]]:
                print("\n  🚨 CONFORMANCE FAILED — the graph disagrees with the CSVs:")
                for c in bad:
                    print(f"    {c['check']}: graph says {c['got']}, "
                          f"CSVs say {c['expect']}")
                rc = 1
            else:
                print(f"  conformance: {len(checks)} counts reconciled against the CSVs")

    if problems:
        # Deduplicate: one dangling finding cited by nine records is one defect.
        uniq = sorted(set(problems))
        print(f"\n  {len(uniq)} problem(s):")
        for p in uniq[:20]:
            print(f"    {p}")
        if len(uniq) > 20:
            print(f"    … and {len(uniq) - 20} more")
        return 1
    if rc == 0:
        print("\n  OK: every citation resolves to a node, and every link the "
              "discipline calls for is written")
    return rc


if __name__ == "__main__":
    sys.exit(main())
