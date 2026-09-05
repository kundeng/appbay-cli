---
spec_id: S38-verification-and-docs
status: CLOSED
closed_as: SHIPPED
since: 2026-09-05
until: null
epic: legibility
features: [honest-tests, dead-code-removal, docs-refresh, lessons-harvested]
supersedes: []
superseded_by: null
depends_on: [S37-ownership]
anchors: [data-architecture]
---

# S38: verification and docs — the repo is fit to study

# 1 · Requirements

## Introduction

After S36 fixed behaviour and S37 fixed ownership, this sprint makes the remaining noise
go away: tests that do not run what they name, dead code, docs that describe a layout that
no longer exists, and the lessons the rewrite has not yet received.

## Mental Model & Invariants

- A test's name is a claim about a behaviour; its body runs that behaviour or the name
  changes.
- `knip` reports zero unused exports.
- Every doc path and symbol resolves.
- stackbay's lessons file carries L9–L13 from `docs/history/seam-review.md`.

## Requirements

### Requirement 1: honest tests
1.1 THE four tests that assert only `toHaveBeenCalled*` SHALL run the boundary against a
    real filesystem or be renamed for what they test.
1.2 THE command actions for `doctor`, `status`, `ps`, `update`, `eject` SHALL each have one
    test that drives the action against a scratch home.

### Requirement 2: dead code
2.1 `knip` SHALL be installed and run in CI; everything it names on first run is deleted or
    justified in the sprint log.

### Requirement 3: docs
3.1 `/spec-docs` SHALL run over `README.md` and `docs/**`; stale paths and symbols fixed.
3.2 `docs/guide/overlays.qmd` and `README.md` SHALL describe `when:` as the collection sprint
    implements it, once it has.

### Requirement 4: harvested
4.1 stackbay `docs/design/lessons-paid-for.md` SHALL gain L9–L13 as proposed in the seam
    review, each with the appbay-cli file and line it came from.

### Requirement 5: secrets never on argv (from the row-23 audit)
5.1 THE shepherd SHALL take any payload on stdin; no secret byte, seed, or bundle SHALL
    appear in the container binary's argv. A test pins it.
5.2 THE five injection modes SHALL be described in `docs/guide/` with the exposure each one
    accepts, so the manifest author's choice is informed.

### Non-Functional
- **NF 1** — a RHEL-family Docker bootstrap run (issue #8) is attempted; if no VM can be
  provisioned, the attempt and its wall are logged and the issue stays open.

## Out of Scope
- New behaviour.

# 2 · Design

## End-to-End Walkthrough
A reader opens `docs/README.md`, follows it to the guide for `up`, reads
`services/deploy-service.ts` and finds one implementation of each thing it does, with
comments that state invariants; opens its test and sees the behaviour run. The rewrite's
author opens L9–L13 and finds the file and line each lesson was paid for at.

## Architecture Overview
No structural change.

## Workflow
```mermaid
flowchart TD
  A([tests]) --> B[rename or replace mock-call tests] --> C[knip] --> D[delete] --> E[spec-docs] --> F[lessons L9-L13]
```

## Testing Strategy
- `pnpm turbo test` green; `knip` zero; `check:docs-cli` and `check-docs-manifests` green.

## Correctness Properties
### Property 1: no name without a run
- **Statement**: for any test whose name contains a verb of effect (writes, creates,
  deploys, runs, installs), its body invokes the code path that performs it.

# 3 · Tasks

- [x] 1. Tests · 1.1 pointer writers on real files; mock-call tests gone; docker wrapper test renamed for what it tests · 1.2 six command actions end to end against a scratch home
- [x] 2. Dead code · 2.1 knip run resolved (see log); no CI to pin it in
- [x] 3. Docs · 3.1 `check:docs-cli` and `check:docs-manifests` green; README and the CLI reference gain `edge migrate`; the reference's `injection` enum lists the five real modes · [>] → S39-collection-boot-order 3.2 `when:` docs follow the collection sprint
- [x] 4. Harvest · 4.1 stackbay `docs/design/lessons-paid-for.md` L9–L13, commit 43b495c
- [x] 5. Bootstrap · 5.1 attempt logged: no RHEL-family image, no Podman; issue #8 stays open
- [x] 6. Secrets · 6.1 shepherd payload on stdin, argv clean, test · 6.2 the secrets guide has a what-each-mode-exposes table

## Log

**2026-09-05** — drafted.

**2026-09-05** — 1.1, 1.2, 2.1, 4.1, 6.1 done. Walls, each attempted:
- 5.1 (issue #8, RHEL-family Docker bootstrap): `multipass find` lists no Fedora, Rocky,
  CentOS or Alma image on this machine; no other VM host is reachable. Issue stays open.
- S36's carried 3.2 (Podman deploy journey): `which podman` → not installed;
  `multipass list` → no instances. The Podman claims in this session's fixes rest on the
  repo's own measurements (banner, `Names[]`, `ps -a` rejection) and on Podman's documented
  `ps --filter label` support, and are marked reasoned in the ledger.
- knip's first run: 35 unused exports and 5 unused types. Sixteen uncalled doctor wrappers
  and five re-exports in `apps/cli/src/utils/checks.ts` deleted; the rest un-exported;
  `packages/db` dropped an unused dependency. Two (`parseKeePassUri`, `parseVaultUri`) are
  exported through a form the un-exporter did not match and stay; `docs/_extensions/
  present-mode/present-mode.js` is a Quarto extension and stays. Not installed in CI: the
  workspace has no CI config to add it to.

**2026-09-05** — shipped. The Podman verification of S36 and S38 is GitHub issue #9;
the RHEL-family Docker bootstrap stays issue #8. Both are external walls attempted this
session and named above. `when:` documentation follows S39.
