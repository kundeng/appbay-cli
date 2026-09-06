---
spec_id: S46-review-fixes
status: CLOSED
closed_as: SHIPPED
since: 2026-09-06
until: null
epic: correctness
features: [wrapper-live-removed, failed-app-blocks-dependents, one-overlay-merge, oneshot-ready, install-as-vault-keys, server-unknown, no-shell-string]
supersedes: []
superseded_by: null
depends_on: [S45-runtime-verification]
anchors: [data-architecture]
---

# S46: the fix-now set from the 2026-09-06 review

# 1 · Requirements

The APPROVED rows of `docs/history/2026-09-06-review/04-RECONCILIATION_PLAN.md`, section E.
Each carries a test that failed before the change. The three decisions (D1 plaintext
fallback, D2 master password at rest, D3 backup trait) and ledger rows 22 and 28 are not
here; nothing below depends on them.

1.1 (F1) THE `injection` enum SHALL contain only modes with a branch behind them.
1.2 (F2) EVERY failure branch in `deploy()` SHALL block the app's dependents.
1.3 (F3) TWO overlays on one service SHALL merge the way the renderer merges.
1.4 (F4) A one-shot service that exited 0 SHALL count as done for readiness.
1.5 (F5) `install --as` SHALL name vault keys after the installed app.
1.6 (F6) THE CLI SHALL not build a shell string from argv.
1.7 (F7) `server start` and `server status` SHALL report unknown as unknown.
1.8 THE four unused exports knip listed SHALL be gone; a manifest or catalog validation
    error SHALL name the field.

# 2 · Design

`notReady.add` at each of the five branches (one helper was considered; the branches carry
different fields, so five lines beat a helper with three optional arguments).
`mergeServiceFragment` from the renderer is the one merge; the overlay engine's copy stays
for its own selection tests and is the next deletion. `isReady` treats `exited` + exit code
0 as done, matching `findCrashedServices`. `serverRunning()` returns `{running, unknown?}`.

# 3 · Tasks

- [x] 1.1 `schemas/appbay-yaml.ts`; secrets guide and manifest reference
- [x] 1.2 `services/deploy-service.ts` ×5; `deploy-readiness.test.ts` (an ingress error on db skips web)
- [x] 1.3 `compiler/compile.ts`; `overlay-merge.test.ts`; scratch render carries both overlays
- [x] 1.4 `runtime/observe.ts`; `deploy-readiness.test.ts` (db with an exited-0 init row)
- [x] 1.5 `services/catalog-service.ts`; `catalog-install-as.test.ts`
- [x] 1.6 `commands/up.ts`
- [x] 1.7 `commands/server.ts`
- [x] 1.8 exports; `catalog/discover.ts` error names the field

## Log

**2026-09-06** — shipped: core 1111 passed, CLI 385, typecheck clean, knip clean of unused
exports.
