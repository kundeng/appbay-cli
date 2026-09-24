---
thread: implementation-maturity
rows: NP5 NP10 NP11 NP12 NP13 NP15
---

# Where the implementation does not match the design

## The question, and what was seen

**Why.** A sound design and a sound implementation are different claims. Having established
that the compiler does what the product says (see
[compiler-mechanism](compiler-mechanism.md)), the next question is where specific stages
fall short of it — and, since the brief asks for defects a maintainer can act on, where the
existing tests fail to notice.

**How.** Three instruments. A differential compile, where two services differ in exactly one
respect so the render diff isolates the cause. A source reread of every site touching the
same compose field, since agreement between stages is not something a test of one stage can
show. And an execution test of the deploy gate, because a safety property should be observed
rather than argued.

**What.** `src/appbay-dockhand/map_form_environment.sh`,
`src/appbay-dockhand/env_defect_blast_radius.sh`,
`src/appbay-dockhand/appbay_dead_surface.sh`, `src/appbay-dockhand/web_cli_parity.sh`,
`src/appbay-dockhand/auth_error_still_deploys.sh`, `src/appbay-dockhand/run_appbay_tests.sh`.

**Where.** Done. One hypothesis was refuted, which is reported as a credit.

## Where it stands

Three maturity defects, of decreasing severity. The compiler's three environment-touching
stages disagree about a form Compose accepts, and the disagreement destroys data silently.
The web UI's deploy path writes the compose and drops the auxiliary files, so the GUI
deploys apps without the routes and policies the compiler produced for them. And a small
amount of lifecycle vocabulary is declared with nothing behind it. Against these, the deploy
gate that most matters — refusing to start an app whose configuration did not compile —
was tested against a real Docker daemon and works.

## The analyses, in order

- **NP5** isolated the environment-form defect with a two-service differential compile.
- **NP10** ran the project's own suite: 1,551 tests, zero failures, while NP5's defect is live.
- **NP11** found why — a passing test asserts the loss — and bounded the fix with CodeGraph.
- **NP12** swept for declared vocabulary with no producer or reader.
- **NP13** compared the web and CLI deploy paths on the one output that distinguishes them.
- **NP15** tested whether a failed trait still deploys. It does not.

## NP5 — the same service, spelled two ways

**Setting.** One app, `mapform`, with two services that are identical except for how
`environment:` is written — `listform` uses the list form, `mapform` the map form. Each
carries a pre-existing variable (`KEEP_ME=important`) and a magic variable
(`GEN_PASSWORD=${password:16}`), and each declares `scoped-env` and `secrets`. Compiled once
with `appbay compile mapform`. Population: these two services; the contrast is the whole
instrument.

**What it tests.** Whether the compiler treats Compose's two accepted spellings of
`environment:` as the same thing.

**Procedure.** Read the three sites in the compiler that touch the field, and note that they
disagree: `compile.ts:1019` skips non-arrays, `scoped-env.ts:34` substitutes an empty array
for one, `secrets.ts:56` branches on array, object and absent. Construct the minimal input
that makes the disagreement observable — two services differing only in spelling, each with
a variable that must survive and a variable that must be generated. Compile once, so both
services pass through one invocation of every stage. Compare the two rendered environments
and the generated-value store.

**Role:** Contrast — the comparison is deterministic and the two arms differ in one respect.

**What was seen.** `listform` rendered
`[KEEP_ME=important, GEN_PASSWORD=<generated>, TEAM=platform, API_TOKEN=${API_TOKEN}]`.
`mapform` rendered `[TEAM=platform, API_TOKEN=${API_TOKEN}]` — `KEEP_ME` and `GEN_PASSWORD`
absent. The store holds one entry, for `listform` alone. The command reported
`1 compiled, 0 error(s)`.

**What each number means.** Two variables lost from one of two services; one store entry
where two were due; zero diagnostics. The zero is the significant figure: the loss is not
merely wrong, it is unobservable to the operator, and the rendered file is the artifact
they would diff.

**Population and exclusions.** Only `runtime-env` secrets injection is exercised;
`wrapper-file` and `entrypoint-wrapper` mount or wrap rather than edit the environment and
are out of scope. `env_file` is untested.

**Overturning evidence.** Equal environments for the two services. A warning naming the
dropped keys would not overturn the loss but would change its severity substantially, since
a stated gap is a different thing from a silent one — the distinction the codebase itself
draws about the backup trait.

Cites [probe-05](../../raw/probe-05-map-form-environment-is-handled-three-ways.yaml),
[F3](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f3).

## NP11 — why 1,551 passing tests do not see it

**Setting.** `scoped-env.test.ts` and `secrets.test.ts` in the pinned tree, read against the
behaviour NP5 measured; CodeGraph for the blast radius of a fix; the seven shipped
system-app manifests classified by environment form.

**What it tests.** Whether the defect is untested or asserted, and what fixing it would
disturb.

**Procedure.** Read the scoped-env suite case by case. Read the sibling trait's suite for
the same construct. Ask CodeGraph for callers and impact of `scopedEnvTraitDefinition` and
of `compile`. Classify each shipped `docker-compose.yml` by whether its first `environment:`
block opens with a list item or a key.

**Role:** Check — this validates the instrument (the suite) rather than answering the
product question.

**What was seen.** The final scoped-env case is titled *"treats object-form environment as
empty array (does not merge)"*, comments that "object-form env is not merged", and asserts
`toEqual(["NEW_VAR=new-value"])`. `secrets.test.ts:177` asserts the opposite for the same
construct, expecting an unrelated key retained. CodeGraph reports four callers of
`scopedEnvTraitDefinition`: two test files and two barrel re-exports. Four of seven shipped
system apps use the map form — `nextcloud`, `jellyfin`, `homeassistant`, `sysinfo` — and
none currently declares `scoped-env`.

**What it means.** The suite is green *because* the behaviour is asserted, not despite it.
This is the signature of a test written from the implementation rather than from the
requirement, and it is why suite colour carries no information about this defect. The narrow
blast radius is the good news: nothing outside the trait depends on the behaviour, so the
fix is bounded by the test that must be inverted.

**Population and exclusions.** "Shipped manifests" means `system-apps/` in the CLI tree
only; the external catalogs are not in either snapshot, so the true exposure is a lower
bound. The classification reads the *first* `environment:` block per file, so a file mixing
forms is counted once.

**Overturning evidence.** A caller of `scopedEnvTraitDefinition` outside tests and barrels
would widen the fix. A shipped manifest combining the map form with `scoped-env` would move
this from armed to fired.

Cites [analysis-11](../../raw/analysis-11-map-form-defect-is-locked-in-by-a-test.yaml),
[probe-10](../../raw/probe-10-appbay-test-suite-at-the-pinned-commit.yaml),
[F4](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f4),
[F16](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f16).

## NP13 — the output that distinguishes the two deploy paths

**Setting.** `appbay-mac@d8f557bc` `apps/web/src`, the only web snapshot available and six
weeks behind the CLI tree. Population: every deploy path the web server exposes — four tRPC
procedures and five queue workers.

**What it tests.** Whether an app deployed from the web UI gets the auxiliary files the
compiler produced for it.

**Procedure.** Enumerate the deploy procedures and the workers. Search all of
`apps/web/src` for `auxiliaryFiles` and classify each occurrence as a write or a read. For
contrast, locate the CLI's installer. Count UI call sites per procedure, to distinguish what
exists from what runs. Count hardcoded runtime binaries on each side. Check whether the web
still calls the current core's API.

**Role:** Result.

**What was seen.** `auxiliaryFiles` occurs **once** under `apps/web/src` — `plans.ts:112`,
mapping it to bare paths for the plan preview. No web path writes it. `deployments.up`
compiles, writes only `docker-compose.rendered.yml`, and spawns `docker compose up -d`; the
queue worker does the same. `deployments.up` has four UI call sites; `fullDeploy`, which
does call core's `deployPipeline` and whose docstring claims "feature parity with
`appbay up`", has **zero**. The web server hardcodes `"docker"` at 16 spawn sites against
the CLI's single `containerBin(appbayHome)` resolver. The web calls `compile({activeApps})`,
an option the current core deliberately removed.

**What it means.** The GUI shows the operator the route files in the plan and then does not
install them. An app deployed from the UI runs without ingress and without its
authorization policy, silently — which is the product's headline output being dropped by
its friendliest surface.

**The instrument, and what it cannot see.** This is a source analysis of a snapshot six
weeks older than the primary subject; `appbay-cli-mac` is current where they disagree, and
it has no web app, so no newer web code was available. If the web has since been rewritten
against the current core, this finding is historical — but the `activeApps` call shows the
two had already diverged at this snapshot, so a rewrite is the fix rather than a reason to
discount it.

**Overturning evidence.** A newer web snapshot writing `auxiliaryFiles`; or a deploy
observed end-to-end through the UI producing a working route.

Cites [analysis-13](../../raw/analysis-13-web-deploy-drops-the-edge-route.yaml),
[F5](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f5).

## NP15 — the gate that holds

**Setting.** Default-provider scratch install, one app declaring `auth` and `ingress`, real
Docker 29.4.0 on the investigation host, `appbay up authgap`. A local state change,
reversible in one command and torn down in the same script.

**What it tests.** Whether an app whose `auth` trait failed to compile is nevertheless
started and routed — publicly reachable with no authorization.

**Procedure.** Build a default install (no `ingress_provider` key), declare `auth` +
`ingress` so the trait errors as NP4 established. Create the external network, run
`appbay up`, then observe three things independently of the command's own report: containers
by label, route files on disk, policy files on disk. Tear down on every exit path.

**Role:** Result.

**What was seen.** `appbay up` exited 1 with *"Failed: authgap — not deployed: its
configuration did not compile (see the errors above). Deploying it would start a container
that cannot serve its declared routes."* `docker ps` by label returned nothing. No route
file and no policy file existed. The gate is `deploy-service.ts:154-164`, which builds
`appsWithCompileErrors` and refuses per app rather than per run, so unrelated targets still
converge.

**What it means.** The hypothesis was wrong and the refutation is worth more than the
finding would have been: the safety property holds, it is per-app rather than all-or-nothing,
and the message names the consequence rather than the error code. `appbay compile` does
still write artifacts alongside a non-zero exit, but `compile` is a preview command and
`up` does not trust its output.

**Overturning evidence.** A running container, or a route file on disk, after a refused
deploy. Both were checked and both were absent.

Cites [action-15](../../raw/action-15-auth-trait-error-does-not-stop-the-deploy.yaml),
[F15](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f15).

## Generated facts

<!-- generated: facts -->
*Generated by `src/appbay-dockhand/study_facts.py` from `INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md` and `raw/`. Do not edit by hand.*

#### NP5

**Settles:** F3, H1 · **Status:** run · **Moved:** F3

**Inputs:** one app, two services differing only in env spelling

**Procedure, as written:** declare `scoped-env` + `secrets` on both, compile, compare renders and the value store

**Records:**
- `raw/probe-05-map-form-environment-is-handled-three-ways.yaml` — **supports**: "Two services identical but for environment spelling. listform (list) keeps KEEP_ME, generates GEN_PASSWORD, gains TEAM and API_TOKEN. mapform (map) renders environment: [TEAM, API_TOKEN] only \u2014 KEEP_ME=important and GEN_PASSWORD are gone, the generated-v
  - runs: `runs/map-form-env-20260924/`

**Findings moved:**
- **[F3]** A map-form `environment:` silently loses every variable it declared — *settled*, role: Result
  - Setting: One app, two services identical but for how `environment:` is spelled, each

#### NP10

**Settles:** F16 · **Status:** run · **Moved:** F16

**Inputs:** sandbox build

**Procedure, as written:** `pnpm turbo test`

**Records:**
- `raw/probe-10-appbay-test-suite-at-the-pinned-commit.yaml` — **supports**: "pnpm turbo test at the pinned tree: 5/5 tasks successful, @appbay/core 85 files / 1148 passed + 1 skipped, @appbay/cli 29 files / 403 passed. Zero failures \u2014 while probe-05 shows live silent data loss, so the suite is green and the defect is real."

**Findings moved:**
- **[F16]** The test suite is green at the commit where F3 is live — *settled*, role: Check
  - Setting: `pnpm turbo test` on the sandbox build of `9f00b579` including its 14

#### NP11

**Settles:** F4 · **Status:** run · **Moved:** F4

**Inputs:** the three env sites + their tests

**Procedure, as written:** CodeGraph impact/callers per symbol; read the asserting test; classify shipped manifests by env form

**Records:**
- `raw/analysis-11-map-form-defect-is-locked-in-by-a-test.yaml` — **supports**: "scoped-env.test.ts:178 is titled 'treats object-form environment as empty array (does not merge)' and asserts environment === ['NEW_VAR=new-value'], i.e. the loss is the expected result. secrets.test.ts:177 asserts the opposite for the same construct ({DB_PAS

**Findings moved:**
- **[F4]** A passing test asserts the loss as correct behaviour — *settled*, role: Check
  - Setting: `packages/core/src/traits/definitions/__tests__/scoped-env.test.ts` in the

#### NP12

**Settles:** F14 · **Status:** run · **Moved:** F14

**Inputs:** `traits/types.ts` vocabulary

**Procedure, as written:** count producers and readers per member; CodeGraph callers for exported compiler symbols

**Records:**
- `raw/analysis-12-appbay-declared-but-unreachable-surface.yaml` — **supports**: ShepherdPhase declares on-stop and cron; on-stop has 0 producers and 0 handling in converges.ts, cron has 0 real producers (the 1 counted by the script is the doc comment at traits/types.ts:109 — a conformance defect in the counting, noted). ShepherdAction.sch

**Findings moved:**
- **[F14]** Declared shepherd vocabulary has no producer and no consumer — *settled*, role: Check
  - Setting: `packages/core/src/traits/types.ts` against every producer and reader in

#### NP13

**Settles:** F5, H1 · **Status:** run · **Moved:** F5

**Inputs:** `appbay-mac` web server

**Procedure, as written:** enumerate deploy paths; grep `auxiliaryFiles` under `apps/web/src`; count UI call sites per procedure; count hardcoded runtimes

**Records:**
- `raw/analysis-13-web-deploy-drops-the-edge-route.yaml` — **supports**: auxiliaryFiles appears exactly once under apps/web/src — plans.ts:112, which maps it to paths for DISPLAY in the plan preview. No web deploy path writes it. deployments.up (4 UI call sites) compiles, writes only docker-compose.rendered.yml, and spawns docker c

**Findings moved:**
- **[F5]** No web deploy path installs the edge route or the authorization policy — *settled*, role: Result
  - Setting: `appbay-mac@d8f557bc` `apps/web/src/server`, the only web snapshot available

#### NP15

**Settles:** F15 · **Status:** run · **Moved:** F15 (refuted)

**Inputs:** default-provider install, real Docker

**Procedure, as written:** `appbay up` an app whose `auth` trait errors; observe containers, routes, policies; tear down

**Records:**
- `raw/action-15-auth-trait-error-does-not-stop-the-deploy.yaml` — **refutes**: "The hypothesis was that a failed auth trait still deploys. It does not. appbay up exits 1 with 'Failed: authgap \u2014 not deployed: its configuration did not compile \u2026 Deploying it would start a container that cannot serve its declared routes.' docker p
  - runs: `runs/auth-gap-20260924/`

**Findings moved:**
- **[F15]** ~~An app whose `auth` trait failed is still deployed and routed~~ — *refuted*, role: Result
  - Setting: Default-provider install, app declaring `auth` + `ingress`, real Docker
<!-- /generated: facts -->
