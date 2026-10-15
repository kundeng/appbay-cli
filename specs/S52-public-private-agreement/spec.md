---
spec_id: S52-public-private-agreement
status: DRAFT
closed_as: null
since: 2026-10-14
until: null
epic: release
features: [open-core-agreement]
supersedes: []
superseded_by: null
depends_on: [S51-one-config-loader]
anchors: []
---

# S52: the public tree is a subset of the private one again

# 1 · Requirements

S48 closed FORK-FORWARD on 2026-10-14 with one gate open: `pnpm check:subset` (`scripts/check-subset.mjs`) exits 1 against the private fork. On 2026-09-28 it measured 350 paths tracked in this public repository and absent from the private one, and 139 shared paths with different blobs. The open-core split rests on the invariant that check enforces: every public path exists in the private tree at the same path, byte-identical. Per-repository suites cannot see a divergence, and the private history and this one diverged long before S48 (`docs/history/2026-09-28-s48-handoff.md`).

## Requirements

1.1 THE private fork SHALL contain every path tracked here, and every shared path SHALL be byte-identical, as measured by `pnpm check:subset` exiting 0.
1.2 Enterprise-only paths in the private fork SHALL be preserved.
1.3 THE reconciliation SHALL merge this repository's history into the private fork through its configured `upstream`, not by copying files, so later `git merge upstream/main` stays clean.
1.4 EACH of the shared-file differences SHALL be classified before the merge (public is right, private is right, both changed) and the classification recorded.
1.5 `check:subset` SHALL NOT be weakened, skipped or narrowed to reach green.
1.6 Both repositories' build, typecheck and test suites SHALL pass after the merge.

## Out of scope

- Moving any file between the public and enterprise sets; `scripts/split-boundary.json` stays as it is unless a classification in 1.4 shows it is wrong, which then becomes an owner question.

# 2 · Design

The order follows the 2026-09-28 handoff's next action: re-measure (the counts are from 2026-09-28; S50 and S51 add public paths), classify the shared differences, merge public history into the private fork on a branch there, resolve per the classification, run both suites and `check:subset`, then merge the private branch. The private tree is not modified before the plan for that branch is approved.

# 3 · Tasks

- [ ] 1.1 Re-measure `check:subset` against the private fork; record the counts and the 350/139 lists. Requirements: 1.1.
- [ ] 1.2 Classify every shared-path difference. Requirements: 1.4.
- [ ] 1.3 Merge public history into a private-fork branch through `upstream`; resolve per 1.2; preserve enterprise-only paths. Requirements: 1.2, 1.3.
- [ ] 1.4 Both suites and `check:subset` green; merge the private branch. Requirements: 1.1, 1.5, 1.6.

## Log

- 2026-10-14: created as S48's FORK-FORWARD successor for its task 3.1 gate (owner, 2026-10-14).
