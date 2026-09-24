# PLAN — AppBay vs Dockhand, judged as a systematic approach to Compose deployments

Cites [INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md](../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md)
and yields to it on facts.

## 1. Outcome

A maintainer can act the next morning on: whether AppBay's systematic approach is real;
whether Dockhand has an overlay model; where Dockhand leads and by what mechanism; a
specification per gap worth closing and a stated list of gaps to leave; and a prioritised
set of pinpointed refactorings.

**Inputs.** `appbay-cli-mac@9f00b579` + 14 uncommitted files; `appbay-mac@d8f557bc`;
`dockhand@99dc1044`. All read-only. CodeGraph indexes current for all three.

**Constraints.** No product change. Sources never written. Artifacts under the working
directory only. Structural claims from CodeGraph, with the query recorded.

**Exclusions.** Running Dockhand; licence and market analysis; Dockhand's Enterprise
features beyond reading them.

## 2. Design

Answer deliverable 2 from **call shape**, not feature names, because a feature crosswalk
cannot see a capability the other side has no name for. Answer deliverable 1 by
**executing** the compiler on a deliberately untailored Compose file — the prior review's
stated weakness was that nothing was run. Separate design / maturity / presentation by
asking a different question of each: does the mechanism exist (read + run), does it do what
it says (run + mutation-test), and can a user find it (measure the built binary).

Affected paths (read only): `packages/core/src/compiler/`, `packages/core/src/traits/`,
`packages/core/src/services/deploy/`, `apps/cli/src/`, `apps/web/src/server/`,
`dockhand/src/lib/server/`.

**Risks.** (i) A sandbox build could diverge from the snapshot — mitigated by rsync from
the immutable tree and recording the one deviation (the lockfile). (ii) Bun-compiled CLI
output can be truncated through a pipe — mitigated by capturing to regular files. (iii) The
web snapshot is six weeks behind the CLI; every web claim states that.

## 3. Tasks

| # | task | settles |
|---|---|---|
| 1 | Build a runnable sandbox from the snapshot | ✅ `dist/appbay --version` → `0.1.0-dev` ([action-03](../raw/action-03-appbay-builds-with-a-refreshed-lockfile.yaml)) |
| 2 | Compile an untailored compose under both providers | ✅ input hash unchanged, routes emitted ([probe-04](../raw/probe-04-untouched-compose-compiles-under-both-edges.yaml)) |
| 3 | Isolate the map-form environment behaviour | ✅ `mapform` lost two variables, 0 errors ([probe-05](../raw/probe-05-map-form-environment-is-handled-three-ways.yaml)) |
| 4 | Settle Dockhand's overlay model from source | ✅ 2 reassignments, both bind-path ([probe-06](../raw/probe-06-dockhand-has-no-compose-overlay.yaml)) |
| 5 | Measure CLI exposure from the binary | ✅ 47/46/4 ([probe-08](../raw/probe-08-cli-exposure-top-level-commands.yaml)) |
| 6 | Mutation-test the docs checker | ✅ 0 → 2 → 1 → 0 ([probe-09](../raw/probe-09-docs-cli-check-detects-injected-drift.yaml)) |
| 7 | Run AppBay's suite | ✅ 1,551 passed, 0 failed ([probe-10](../raw/probe-10-appbay-test-suite-at-the-pinned-commit.yaml)) |
| 8 | Blast radius for the env defect | ✅ 4 callers; the asserting test found ([analysis-11](../raw/analysis-11-map-form-defect-is-locked-in-by-a-test.yaml)) |
| 9 | Sweep declared-but-unreachable surface | ✅ `on-stop`, `cron`, `schedule` ([analysis-12](../raw/analysis-12-appbay-declared-but-unreachable-surface.yaml)) |
| 10 | Web/CLI deploy parity | ✅ 1 display-only `auxiliaryFiles` reference ([analysis-13](../raw/analysis-13-web-deploy-drops-the-edge-route.yaml)) |
| 11 | Dockhand's leads, with mechanisms | ✅ ([analysis-14](../raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml)) |
| 12 | Test whether a failed `auth` trait still deploys | ✅ refuted — `up` refuses ([action-15](../raw/action-15-auth-trait-error-does-not-stop-the-deploy.yaml)) |
| 13 | Write seven specs + the do-not-close list | ✅ `docs/specs/SPEC-000..007` |
| 14 | Write report and supplement | ✅ |

## 4. Checks

| check | expected | observed |
|---|---|---|
| `audit.py check` | no orphans, no `TODO` verdicts | ✅ OK — 23 records, 0 TODO, 0 orphans |
| `yq '.' raw/*.yaml` | every record parses | ✅ all 23 parse under mikefarah yq v4.53.2 |
| `work-graph.py --ladybug` | `conformance: N counts reconciled` | ✅ 249 nodes / 344 edges, 27 counts reconciled, `dangling_edges.csv` empty |
| store round-trip | a human edit survives a rebuild | ✅ [probe-16](../raw/probe-16-human-judgement-survives-a-store-rebuild.yaml) |
| every claim ID cited resolves to an anchor | no dead links | ✅ 218 local links, 0 broken (`src/appbay-dockhand/check_links.py`) |
| sources unmodified | `git status` matches each `.meta.json` | ✅ all three HEADs and uncommitted lists unchanged |
| study facts regenerated | generated, not hand-written | ✅ [analysis-22](../raw/analysis-22-study-facts-generated-from-the-workbook.yaml) |

**One check does not pass, and is recorded rather than worked around.** The projector's
`RAISES` edge stays empty: it reads an inquiry row's `settles` from the second and third
body cells, where the documented column order puts it first. The link is expressed in the
workbook; the tool reads a different column.

**Stopping condition.** Each of the five deliverables is answered by at least one record
with a filled verdict, and every prior-work lead is confirmed or refuted by name.

## 5. Next action

Apply **SPEC-001** — one environment model across the compiler. It is the only finding that
destroys operator data, its blast radius is four callers (two tests, two barrels), and the
first edit is inverting `scoped-env.test.ts:178` so the suite stops asserting the loss.
