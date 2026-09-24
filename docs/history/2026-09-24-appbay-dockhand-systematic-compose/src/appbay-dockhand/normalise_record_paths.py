#!/usr/bin/env python3
"""Make `derived:` and `log:` paths investigation-relative, and add the two edge keys.

WHY THIS TOUCHES raw/. Two mechanical corrections, neither of which changes what any
record observed:

1. `derived:` paths were captured absolute, because `rec --run-dir` was given an absolute
   directory. They are correct but unusable here: this investigation happens to live under
   a directory named `runs/` (the eval harness's own `runs/dockhand-v2/workdir/...`), and
   the projector's `(?:^|/)runs/([^/]+)/` matches that FIRST occurrence, so every artifact
   was attributed to a run named `dockhand-v2` that does not exist — leaving Run and
   Artifact both populated with zero WROTE edges between them. Rewriting the prefix to the
   investigation-relative form the record contract's own example uses preserves the
   referent exactly; bytes and sha256 are untouched and re-verified below.

2. `bears_on:` is added to the three records that bear on H1. The projector documents this
   as a record key rather than something inferred from prose, and without it the corpus has
   records and a hypothesis with nothing connecting them.

Idempotent: a second run finds nothing to change.
"""
from __future__ import annotations
import hashlib, re, sys
from pathlib import Path

INV = Path(__file__).resolve().parents[2]
PREFIX = str(INV) + "/"

# Records whose evidence bears on H1 (presentation vs substance), and why.
BEARS_ON = {
    "probe-05-map-form-environment-is-handled-three-ways": "H1",
    "analysis-13-web-deploy-drops-the-edge-route": "H1",
    "probe-08-cli-exposure-top-level-commands": "H1",
}

changed, rehashed, mismatched = 0, 0, []
for rec in sorted((INV / "raw").glob("*.yaml")):
    text = rec.read_text()
    original = text
    text = text.replace(PREFIX, "")
    if text != original:
        changed += 1
    stem = rec.stem
    if stem in BEARS_ON and "bears_on:" not in text:
        # Insert beside the other top-level keys, after claim.
        text = re.sub(r"^(claim: .*\n)", rf"\1bears_on: [{BEARS_ON[stem]}]\n",
                      text, count=1, flags=re.M)
    if text != original:
        rec.write_text(text)

# Re-verify every derived artifact still hashes to what the record claims.
for rec in sorted((INV / "raw").glob("*.yaml")):
    for m in re.finditer(r"- path: (\S+)\n\s+bytes: (\d+)\n\s+sha256: ([0-9a-f]{64})",
                         rec.read_text()):
        path, want_bytes, want_sha = m.group(1), int(m.group(2)), m.group(3)
        f = INV / path
        if not f.exists():
            mismatched.append(f"MISSING {path}")
            continue
        data = f.read_bytes()
        got = hashlib.sha256(data).hexdigest()
        rehashed += 1
        if got != want_sha or len(data) != want_bytes:
            mismatched.append(f"CHANGED {path}: {want_sha[:12]} -> {got[:12]}")

print(f"records with paths rewritten: {changed}")
print(f"derived artifacts re-verified: {rehashed}")
print(f"mismatches: {len(mismatched)}")
for m in mismatched:
    print("  " + m)
sys.exit(1 if mismatched else 0)
