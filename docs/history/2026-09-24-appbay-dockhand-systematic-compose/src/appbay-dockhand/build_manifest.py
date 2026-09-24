#!/usr/bin/env python3
"""One line per raw file: what it is, what it proves, and where it is cited.

Generated from the records themselves and from the documents that cite them, so a raw file
that nothing cites shows up as uncited rather than being quietly assumed load-bearing.
"""
from __future__ import annotations
import hashlib, json, re
from pathlib import Path

INV = Path(__file__).resolve().parents[2]
RAW = INV / "raw"
DOCS = [p for p in INV.rglob("*.md") if "runs/" not in str(p.relative_to(INV))]
doctext = {p: p.read_text() for p in DOCS}

def field(text, key):
    m = re.search(rf"^{key}: (.+)$", text, re.M)
    return m.group(1).strip().strip('"') if m else ""

entries = []
for f in sorted(RAW.rglob("*")):
    if not f.is_file() or f.name == "manifest.json":
        continue
    rel = f.relative_to(INV).as_posix()
    data = f.read_bytes()
    e = {"path": rel, "bytes": len(data),
         "sha256": hashlib.sha256(data).hexdigest()}
    if f.suffix == ".yaml" and f.parent == RAW:
        text = data.decode("utf-8", "replace")
        e["kind"] = field(text, "type")
        e["verdict"] = field(text, "verdict")
        e["claim"] = field(text, "claim")
        e["proves"] = field(text, "key_evidence")[:400]
        e["cited_by"] = sorted(p.name for p in DOCS if f.stem in doctext[p])
    elif f.parent.name == "code":
        e["kind"] = "executed-code"
        e["proves"] = "immutable copy of code a record executed"
    elif f.parent.name == "logs":
        e["kind"] = "full-output"
        e["proves"] = "complete output behind a capped excerpt"
    else:
        e["kind"] = "other"
        e["proves"] = ""
    entries.append(e)

records = [e for e in entries if e.get("kind") and e["kind"] not in
           ("executed-code", "full-output", "other")]
uncited = [e["path"] for e in records if not e.get("cited_by")]
(RAW / "manifest.json").write_text(json.dumps({
    "investigation": INV.name,
    "generated_by": "src/appbay-dockhand/build_manifest.py",
    "file_count": len(entries),
    "record_count": len(records),
    "verdicts": {v: sum(1 for e in records if e.get("verdict") == v)
                 for v in sorted({e.get("verdict", "") for e in records})},
    "uncited_records": uncited,
    "files": entries,
}, indent=2) + "\n")

print(f"files: {len(entries)}  records: {len(records)}  uncited: {len(uncited)}")
for e in records:
    print(f"  {e['verdict']:<13} {e['path']}")
