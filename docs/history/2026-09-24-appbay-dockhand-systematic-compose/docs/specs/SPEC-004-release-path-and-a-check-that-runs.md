---
spec: SPEC-004
title: A release path that works and a check that runs
closes: F7, F12
status: proposed
priority: 4 — trivial effort, blocks shipping
---

# SPEC-004 — A release path that works and a check that runs

## Requirement

`git tag v0.1.0 && git push --tags` must produce release artifacts. The repository's own
consistency checks must run on every push and their result must mean something.

## Why

`pnpm-lock.yaml` still lists `@appbay/core` as a dependency of `packages/db`, which that
package no longer declares, so `pnpm install --frozen-lockfile` exits 1. The team
diagnosed this and disabled `ci.yml`, documenting the one-command fix in
`.github/workflows.disabled/README.md`. What that README does not say is that
`release.yml` is still live, triggers on `v*.*.*`, and runs the same command at line 53 —
so the project cannot cut a tagged release at this commit
([F7](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f7)).

Separately, `scripts/check-docs-cli.mjs` is a genuinely sensitive check — mutation-tested
three ways in [F12](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f12) —
that nothing runs, because CI is off for the lockfile reason. The prior review recommended
repairing it; it does not need repair, it needs a trigger.

## Design, on existing seams

1. `pnpm install` at the repo root; commit the refreshed `pnpm-lock.yaml`. One command, and
   `action-03` confirms the tree builds cleanly afterwards: 3 of 3 turbo packages, and
   `dist/appbay --version` prints `0.1.0-dev`.
2. `git mv .github/workflows.disabled/ci.yml .github/workflows/ci.yml`. The file already
   exists and is already correct.
3. Add the checks that exist and are not wired, as CI steps after `pnpm build`:
   `check:docs-cli`, `check:system-apps`, `check:docs-manifests`, `check:straddle`,
   `check:subset`, `check:server-compose` — all six are already `package.json` scripts.
4. Keep `.github/workflows.disabled/README.md` as an archived note with a forward link,
   rather than deleting it; it records why CI was off and is the best evidence that the
   decision was deliberate.

Step 3 is where the value is. A lockfile fix that only un-reds the build leaves six written
checks unrun; wiring them is what converts this from housekeeping into a guard.

## What it must not break

- **`--frozen-lockfile` must stay.** It is what makes CI reproducible. The fix is to make
  the lockfile current, never to relax the flag — this investigation used
  `--no-frozen-lockfile` only to get a sandbox, and that is not a repository change.
- **`release.yml` must keep its tag-only trigger.** It produces no push noise, which is why
  it survived the CI cull.
- **`check:docs-cli` needs a built binary.** It resolves `./apps/cli/dist/appbay` relative
  to the working directory and exits 2 if absent — the failure this investigation hit
  before correcting its own cwd, and most likely the origin of the prior review's "inert"
  verdict. Order the CI step after `pnpm build` and run it from the repo root.

## How to verify

- `pnpm install --frozen-lockfile` exits 0 at the repo root.
- A dry-run tag on a branch produces the four platform binaries.
- Re-run `src/appbay-dockhand/docs_check_detects_drift.sh` against the updated tree: the
  three-way mutation result (0 → 2 → 1 → 0 discrepancies) must be unchanged, proving the
  check still detects drift after being wired up.
