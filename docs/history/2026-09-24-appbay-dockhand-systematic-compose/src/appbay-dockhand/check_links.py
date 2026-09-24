#!/usr/bin/env python3
"""Every local link and anchor in the artifacts resolves.

`audit.py check` verifies citations from the workbook to raw/. This checks the other
direction and everything between: that each `[Fnn](#fnn)` has an `<a id>` to land on, that
each cross-document link names a file that exists, and that no heading was cited by wording
instead of by id.
"""
from __future__ import annotations
import re, sys
from pathlib import Path

INV = Path(__file__).resolve().parents[2]
DOCS = sorted(p for p in INV.rglob("*.md") if "runs/" not in str(p.relative_to(INV)))
LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
ANCHOR = re.compile(r'<a id="([^"]+)"></a>')

anchors = {}
for d in DOCS:
    anchors[d] = set(ANCHOR.findall(d.read_text()))

bad, checked = [], 0
for d in DOCS:
    text = d.read_text()
    for label, target in LINK.findall(text):
        if target.startswith(("http://", "https://", "mailto:")):
            continue
        checked += 1
        path_part, _, frag = target.partition("#")
        if path_part:
            tgt = (d.parent / path_part).resolve()
            if not tgt.exists():
                bad.append(f"{d.relative_to(INV)}: missing file -> {target}")
                continue
        else:
            tgt = d
        if frag and tgt.suffix == ".md" and frag not in anchors.get(tgt, set()):
            bad.append(f"{d.relative_to(INV)}: no anchor '{frag}' in {tgt.name} -> {target}")

print(f"documents: {len(DOCS)}")
print(f"local links checked: {checked}")
print(f"broken: {len(bad)}")
for b in bad:
    print("  " + b)
sys.exit(1 if bad else 0)
