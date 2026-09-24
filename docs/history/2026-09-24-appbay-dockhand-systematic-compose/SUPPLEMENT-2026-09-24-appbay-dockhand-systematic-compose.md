# Supplement — reproduction detail

One entry per claim marker in
[the report](REPORT-2026-09-24-appbay-dockhand-systematic-compose.md). Each names its
producing code and answers, in order: inputs, definitions, procedure, population, what each
number means, and what would falsify it.

**Assumption ledger, applying to every entry.**
1. The sandbox build at `scratch/appbay-sandbox` is behaviourally identical to the snapshot.
   It is an `rsync` of the tree excluding `.git`, `.codegraph` and `.kilo`, with one
   deviation: the lockfile was refreshed, because the pinned one does not install (M14).
   Refreshing a lockfile can change transitive versions; nothing in these findings depends
   on a dependency's behaviour.
2. CodeGraph's indexes are current and resolve static call edges only. A caller reached
   through a dynamic import would not appear.
3. `appbay-mac@d8f557bc` is six weeks older than `appbay-cli-mac@9f00b579`. Every web claim
   states this; where they disagree, the CLI tree is current.
4. Dockhand was read, never executed.
5. The investigation directory lies under a path containing `runs/`, which the work-graph
   projector's run-path regular expression also matches. Record `derived:` paths were made
   investigation-relative for that reason; all 92 artifacts were re-hashed afterwards with
   zero mismatches (M15).

---

## M1 — an untailored Compose file compiles to a full deployment

**Producing code:** `src/appbay-dockhand/compile_untouched_compose.sh`.

**Inputs.** A scratch `APPBAY_HOME` per provider, built by the script, containing:
`etc/system.yaml` (`domain: lab.example.com`, `ingress_provider: traefik|caddy`),
`etc/namespaces/default.yaml` (`DOMAIN`, `TEAM`), `etc/apps/demo/docker-compose.yml` (2
services, 16 lines) and `etc/apps/demo/appbay.yaml` (1 app trait, 3 service traits). The
binary is `scratch/appbay-sandbox/apps/cli/dist/appbay`, built from `9f00b579`.

**Definitions.** *Untailored* means the Compose file contains nothing that presupposes
AppBay: no `com.appbay.*` label, no `appbay_shared` network, no proxy label, no reference to
a namespace value. *Auxiliary file* means compiler output other than the rendered Compose
file. The unit of analysis is one app compiled once per provider.

**Procedure.**
1. For each provider in `traefik`, `caddy`: remove and recreate the home directory, so
   neither run can observe the other's generated values or renders.
2. Write the four files above. The `web` service publishes `8080:80`, sets
   `WHOAMI_NAME=demo` and `ADMIN_PASSWORD=${password:24}` in list form, and restarts unless
   stopped. The `db` service sets `POSTGRES_PASSWORD: ${password:32}` in map form and mounts
   a named volume.
3. Run `APPBAY_HOME=$home appbay compile demo`, capturing stdout and stderr to separate
   regular files. Record the exit status.
4. Copy the rendered Compose file; enumerate and print every file under the render
   directory; print each auxiliary file in full.
5. After both runs, print the SHA-256 of each home's input Compose file.

**Population.** One app, two services, four traits. Included: `ingress`, `auth`,
`scoped-env`, `secrets` with `runtime-env` injection. Excluded: `gpu` (needs runtime facts
this host cannot supply), `hooks`, `backup` (emits metadata only), and the `wrapper-file`
and `entrypoint-wrapper` secret modes.

**What each number means.** *Exit 0 / 1* is the command's own verdict, and under Traefik the
1 is the `auth` trait refusing the provider (M5). *`571417f282386e77e32d956fde779272be65a11c8e4db83c0e4b18ebb6326404`*
is the SHA-256 of the input Compose file, printed after each compile and identical to its
pre-run content: the compiler is non-destructive to its input. *Alias `demo_web`* is the
shared-network name both the compose fragment and the route fragment use, and their
agreement is what makes the route resolve. *Host `demo.lab.example.com`* was written in no
file — it is derived from the install domain and the app's identity, which is the property
that lets two instances of one app route differently without either manifest changing.

**What would falsify it.** A changed input hash. A missing auxiliary file under either
provider. A rendered service still publishing `8080:80`. A route pointing at a name the
compose fragment does not publish. A default host of `demo.local`, which would show the
derivation ignoring the install domain.

**Record:** [probe-04](raw/probe-04-untouched-compose-compiles-under-both-edges.yaml).
**Run:** `runs/compile-untouched-20260924/`.

---

## M2 — a map-form `environment:` loses its variables

**Producing code:** `src/appbay-dockhand/map_form_environment.sh`.

**Inputs.** One scratch home; `etc/apps/mapform/docker-compose.yml` with two services,
`listform` and `mapform`, running the same image; `etc/apps/mapform/appbay.yaml` declaring
`scoped-env` and `secrets` on each. One `appbay compile mapform`.

**Definitions.** *List form* is `environment: ["K=v"]`; *map form* is
`environment: {K: v}`. Compose accepts both and treats them as equivalent. *Magic variable*
is AppBay's `${password:N}`, `${uuid}`, `${base64:N}` — distinct from Compose's own
`${VAR}` and `${VAR:-default}`, which the compiler deliberately leaves alone. The unit of
analysis is one service.

**Procedure.**
1. Read the three compiler sites that touch the field and note the disagreement:
   `compiler/compile.ts:1019` (`if (!Array.isArray(svc.environment)) continue`),
   `traits/definitions/scoped-env.ts:34` (`Array.isArray(env) ? env : []`),
   `traits/definitions/secrets.ts:56` (branches on array, object and absent).
2. Construct two services identical in image and traits, differing only in the spelling of
   `environment:`. Give each a variable that must survive (`KEEP_ME=important`) and a magic
   variable that must be generated (`GEN_PASSWORD=${password:16}`).
3. Declare `scoped-env` (injecting `TEAM` from the namespace) and `secrets` (one vault ref)
   on both, so all three sites act on both services.
4. Compile once, so both services pass through one invocation of every stage.
5. Compare the two rendered environments and the generated-value store.

**Population.** Two services in one app. Included: `runtime-env` secrets injection.
Excluded: `env_file`, `wrapper-file` and `entrypoint-wrapper` — the latter two mount or wrap
rather than edit the environment.

**What each number means.** *`listform` renders four entries* — `KEEP_ME` preserved,
`GEN_PASSWORD` replaced by a generated value, `TEAM` injected, `API_TOKEN` wired — which is
the correct result. *`mapform` renders two* — only `TEAM` and `API_TOKEN`: the two variables
the developer wrote are gone. *The store holds one entry* rather than two, confirming the
magic variable was never generated rather than generated and then dropped. *`0 error(s)`* is
the significant figure: the loss is invisible to the operator, and the rendered file is the
artifact they would diff.

**What would falsify it.** Equal environments for the two services. A warning naming the
dropped keys would not overturn the loss but would change its severity considerably — the
distinction between a silent gap and a stated one that this codebase itself draws about the
backup trait.

**Untested assumption.** That a map-form environment reaching Compose *unmodified* behaves
as the developer intended. The `db` service in M1 rendered `POSTGRES_PASSWORD: ${password:32}`
literally; whether Compose then errors, interpolates, or passes it through was not tested.
Either way no password was generated.

**Record:** [probe-05](raw/probe-05-map-form-environment-is-handled-three-ways.yaml).
**Run:** `runs/map-form-env-20260924/`.

---

## M3 — the loss is asserted by a passing test

**Producing code:** `src/appbay-dockhand/env_defect_blast_radius.sh`.

**Inputs.** `packages/core/src/traits/definitions/__tests__/scoped-env.test.ts` and
`__tests__/secrets.test.ts`; CodeGraph's caller and impact sets; the seven
`system-apps/*/docker-compose.yml` manifests. Separately,
`src/appbay-dockhand/run_appbay_tests.sh` ran `pnpm turbo test` over the sandbox build.

**Definitions.** A test *asserts* a behaviour when its expectation encodes that behaviour as
correct, as distinct from not covering it. *Blast radius* is CodeGraph's caller set, with
test files and barrel re-exports separated from production call sites.

**Procedure.** Read the scoped-env suite case by case and locate any case covering the map
form. Read the sibling trait's suite for the same construct. Query
`codegraph callers scopedEnvTraitDefinition` and `codegraph impact compile`. For each
shipped manifest, classify the first `environment:` block by whether the following line is a
list item or a key. Cross-check against each app's `appbay.yaml` for a `scoped-env` trait.
Independently, run the full suite and record the totals.

**Population.** Two test files; all seven shipped system apps in the CLI tree. Excluded: the
external catalogs, which are in neither snapshot, so the exposure figure is a lower bound.
The classification reads the first `environment:` block per file, so a file mixing forms is
counted once.

**What each number means.** *`toEqual(["NEW_VAR=new-value"])`* under a case titled *"treats
object-form environment as empty array (does not merge)"* is the loss asserted as the
expected result. *`secrets.test.ts:177`*, passing `{DB_PASSWORD: "placeholder", OTHER: "keep"}`
and expecting `OTHER` retained, is the same construct asserted the opposite way in the same
repository. *Four callers* — two test files, two barrel re-exports, zero production call
sites — bounds the fix. *1,551 tests passed, 0 failed* means suite colour carries no
information about this defect. *Four of seven shipped apps use the map form, none declaring
`scoped-env`* means the destructive path is armed in the shipped catalog but not fired.

**What would falsify it.** A production caller of `scopedEnvTraitDefinition`, which would
widen the fix. A shipped manifest combining the map form with `scoped-env`, which would move
this from armed to fired.

**Records:** [analysis-11](raw/analysis-11-map-form-defect-is-locked-in-by-a-test.yaml),
[probe-10](raw/probe-10-appbay-test-suite-at-the-pinned-commit.yaml).
**Runs:** `runs/env-defect-radius-20260924/`, `runs/appbay-tests-20260924/`.

---

## M4 — no web deploy path installs the auxiliary files

**Producing code:** `src/appbay-dockhand/web_cli_parity.sh`.

**Inputs.** `appbay-mac@d8f557bc` `apps/web/src` (136 files); `appbay-cli-mac@9f00b579`
`packages/core/src/services/deploy/`.

**Definitions.** A *deploy path* is any server-side code that applies a compiled app to a
runtime. *Installs* means writes the auxiliary file to the filesystem the edge reads, as
distinct from listing, returning or displaying it.

**Procedure.**
1. Enumerate the tRPC procedures in `routers/deployments.ts` and the workers under
   `queue/workers/`.
2. Search all of `apps/web/src` for `auxiliaryFiles` and read each occurrence, classifying
   it as a write or a read.
3. Locate the CLI's installer for contrast.
4. For each deploy procedure, count call sites *outside* `src/server`, to separate what
   exists from what the interface runs.
5. Count `"docker"` string literals in the web server, and compare with the CLI's resolver.
6. Check whether the web still calls the current core's compile API.

**Population.** Four deploy-related procedures (`applyPlan`, `up`, `enqueue`, `fullDeploy`)
and five queue workers. Excluded: `down`, `restart`, `list`, `get`, which do not apply a
compiled app.

**What each number means.** *One occurrence of `auxiliaryFiles`, at `plans.ts:112`, mapping
to bare paths* — the plan preview shows the operator route files that no apply will write.
*`deployments.up`: four call sites; `fullDeploy`: zero* — the correct implementation exists
and is unreachable from the interface. *16 hardcoded `"docker"`* against one
`containerBin(appbayHome)` resolver means podman installations are broken in the interface
by construction. *`compile({activeApps})`* is an option the current core removed with a
stated reason, so the two halves had already diverged at this snapshot.

**What would falsify it.** A newer web snapshot writing `auxiliaryFiles`. An end-to-end
deploy through the interface producing a working route. A wrapper that installs auxiliary
files elsewhere in the request path — searched for and not found.

**Record:** [analysis-13](raw/analysis-13-web-deploy-drops-the-edge-route.yaml).
**Run:** `runs/web-cli-parity-20260924/`.

---

## M5 — the default edge cannot run the `auth` trait

**Producing code:** `src/appbay-dockhand/compile_untouched_compose.sh` (second reading).

**Inputs.** As M1. The Traefik home's `etc/system.yaml` sets the provider explicitly; the
constant is `packages/core/src/schemas/instance.ts:72`.

**Definitions.** The *code default* is the value `resolveIngressProvider` returns when
neither the environment variable nor the instance config names one.

**Procedure.** Compile the same manifest under each provider and compare exit status and
emitted artifacts. Separately, read the constant and the guard at `auth.ts:77`, and confirm
by grep that `init.ts` writes the key only when it differs from the default.

**Population.** One manifest, two providers.

**What each number means.** *Exit 1 under Traefik, 0 under Caddy*, from one manifest,
isolates the provider as the cause. The message — *"The auth trait requires the Caddy
Security edge"* — is the guard firing, not a schema failure.

**What would falsify it.** A compile succeeding under Traefik with an `auth` trait. A
different constant value, or `init` writing `caddy` by default.

**Caveat carried into SPEC-003.** Because `init` writes the key only when it differs from
the default, installations created on today's default carry **no** key. Changing the
constant would silently change their edge. That is the migration hazard, and it is the real
work in that specification.

**Record:** [probe-04](raw/probe-04-untouched-compose-compiles-under-both-edges.yaml).

---

## M6 — a failed trait does not deploy

**Producing code:** `src/appbay-dockhand/auth_error_still_deploys.sh`.

**Inputs.** A scratch home with **no** `ingress_provider` key, so the code default applies;
one app declaring `auth` and `ingress`; a real Docker daemon, 29.4.0, on the investigation
host. This was a local state change, reversible in one command and torn down in the same
script on every exit path.

**Definitions.** *Deployed* means a container running with the app's identity label. The
question is whether the compile error prevents it.

**Procedure.** Build the default install. Create the external network. Run
`appbay up authgap`, capturing stdout and stderr to separate files. Then observe three
things *independently of the command's own report*: containers filtered by
`label=com.appbay.app=authgap`; route files under the render tree and under
`etc/apps/traefik`; policy files anywhere in the home. Tear down.

**Population.** One app, one deploy attempt.

**What each number means.** *Exit 1* with *"not deployed: its configuration did not compile
… Deploying it would start a container that cannot serve its declared routes"* is a refusal
naming the consequence. *Empty `running.txt`, `routes.txt` and `policies.txt`* are the
independent confirmations: nothing started, nothing was written. The gate is
`deploy-service.ts:154-164`, which refuses per app rather than per run, so unrelated targets
still converge.

**What would falsify it.** A running container, or any route or policy file, after a refused
deploy. Both were checked directly rather than inferred from the exit status.

**Record:** [action-15](raw/action-15-auth-trait-error-does-not-stop-the-deploy.yaml).
**Run:** `runs/auth-gap-20260924/`.

---

## M7 — command exposure, and whether the docs checker checks

**Producing code:** `src/appbay-dockhand/cli_exposure.sh`,
`src/appbay-dockhand/docs_check_detects_drift.sh`.

**Inputs.** The built binary; `docs/reference/cli-commands.qmd`;
`apps/cli/src/commands/retired.ts`; `scripts/check-docs-cli.mjs` run from the sandbox repo
root.

**Definitions.** A *top-level command* is a name in the `Commands:` block of
`appbay --help`. A *retirement notice* is a name declared in `retired.ts`, which prints a
migration message and exits 1. *Documented* means the reference has a heading matching
`^#+ +\`?appbay <name>`.

**Procedure.**
1. Parse the `Commands:` block, first token per line.
2. Subtract the retirement notices and commander's built-in `help`.
3. Extract command headings from the reference; compare both ways with `comm`.
4. Ask each command for its own `--help`; match `--json` anchored at a word boundary.
5. Run the repository's checker from the repo root.
6. Mutation test: copy the reference aside with a restoring trap; append a section
   documenting `appbay teleport`; run. Restore; append a block invoking
   `appbay status --telepathy`; run. Restore; run as a control.

**Population.** Top-level commands only. Subcommands are excluded because they are reached
through a parent, and counting them inflates both the surface and the documentation gap —
the error in the superseded first attempt.

**What each number means.** *51 names − 4 notices = 47 real commands.* *46 documented; gap =
`exec`, `run`.* *4 with `--json`* out of 47. *0 → 2 → 1 → 0 discrepancies* across the
mutation sequence: the checker detects a documented-but-absent command and a
documented-but-absent flag, and returns to green when the file is restored, so its
zero-discrepancy result on the shipped tree carries information.

**What would falsify it.** A green result on either injected mutation. A documentation
surface other than `cli-commands.qmd` that a reader would treat as the command reference —
the README's command table is the candidate, and it is the stated weak point of M7.

**Untested assumption.** The checker also reports undocumented flags, deliberately as a
report rather than a failure. That third class was not exercised; a checker can be sensitive
to two classes and wrong about a third.

**Superseded attempt.** [probe-07](raw/probe-07-cli-exposure-measured-from-the-binary.yaml)
counted `--json` with `grep -c 'json$'`, which also matches `no-json` (51 + 47 = 98 over 51
commands), and built its command population from `new Command("…")` across all command
files, sweeping in subcommands. Retained, with an `inconclusive` verdict.

**Records:** [probe-08](raw/probe-08-cli-exposure-top-level-commands.yaml),
[probe-09](raw/probe-09-docs-cli-check-detects-injected-drift.yaml).
**Runs:** `runs/cli-exposure-20260924b/`, `runs/docs-check-mutation-20260924/`.

---

## M8 — only four commands emit JSON

Same inputs, procedure, population and records as M7 step 4.

**What each number means.** *4 of 47.* The four are `doctor`, `list`, `ps`, `status`. The
previous review's figure — 16 of 23 *state-reporting* commands lacking `--json` — is over a
narrower population and so is not directly comparable; defining "state-reporting" requires a
judgement this investigation did not want to smuggle into a count. 4 of 47 is mechanical and
points the same way.

**What would falsify it.** A command emitting JSON under a differently-named flag, or under
an environment variable rather than a flag. The match was anchored on `--json` only.

---

## M9 — Dockhand does not transform the Compose file

**Producing code:** `src/appbay-dockhand/dockhand_overlay_surface.sh`.

**Inputs.** `dockhand@99dc1044`, all of `src/` — 1,317 files, 17,633 indexed nodes, 63,868
indexed edges.

**Definitions.** An *overlay model* is code that takes a Compose file the tool did not author
and systematically adds deployment concerns. A *producer* of a proxy configuration string
writes it into an artifact; a *reader* matches it in input.

**Procedure.**
1. `codegraph callees deployStack` to establish the path to the spawn.
2. In `executeLocalCompose`, list every assignment to the variable written to the child
   process, and read each assigning function.
3. `codegraph callers rewriteComposeVolumePaths`.
4. Count eight proxy-configuration strings across `src/`, excluding the generated OpenAPI
   document, and read every hit to classify it.
5. Read the two modules whose names suggest proxy involvement.

**Population.** Every function on the deploy path; every occurrence of the eight strings
anywhere in `src/`. Excluded: `tests/` and the generated OpenAPI document.

**What each number means.** *Two assignments* — `stacks.ts:1258` and `:1279` — is the
complete set of compose mutations; both are line-regex bind-path rewrites, and the first has
one production caller. *Zero occurrences* of `traefik.enable`, `certresolver`, `acme`,
`letsencrypt`, `forward_auth` and `authorization policy` means no proxy configuration is
produced anywhere. *All seven `traefik.http.routers` occurrences are reads or prose* — the
distinction that separates a reader from a producer.

**What would falsify it.** A third assignment to the compose content. Any code emitting a
`traefik.*` or `caddy.*` label rather than matching one. A transform reached through a
dynamic import, which CodeGraph's static edges would not show — mitigated because the grep
half is independent of call shape, and the remote paths were read directly.

**Deliberate exclusion.** Running Dockhand and diffing a deployed container's labels against
its Compose file would be stronger evidence. It was excluded on proportion: it requires
standing up the application, a database and a Docker host under a BSL 1.1 licence, to test a
negative the source settles unambiguously.

**Record:** [probe-06](raw/probe-06-dockhand-has-no-compose-overlay.yaml).
**Run:** `runs/dockhand-overlay-20260924/`.

---

## M10–M13 — Dockhand's leads

**Producing code:** `src/appbay-dockhand/dockhand_leads.sh`.

**Inputs.** `dockhand@99dc1044` `src/`; `appbay-cli-mac@9f00b579` `packages/core/src`;
`appbay-mac@d8f557bc` `apps/web/src`.

**Definitions.** A *lead* is a capability Dockhand has built and AppBay has not. The
*mechanism* is the code that implements it, named so a maintainer can price the gap.

**Procedure.** *Multi-host (M10):* read the `environments` schema; count `envId` references
and the files containing them; identify the transport function; find AppBay's transport and
its route-delivery call site. *Multi-user (M11):* list the identity tables; read the
authorization gate's interface; count licence checks; compare with AppBay's edge-user
surface. *GUI (M12):* count files, lines, top-level page directories and API route handlers
on both sides. *Elsewhere (M13):* count modules per subsystem and name the tables.

**Population.** The three leads named in the brief, plus every Dockhand subsystem with a
database table and a scheduled task behind it. Excluded: Enterprise features were read, not
exercised, so M11's claims describe code rather than a running system.

**What each number means.** *2,822 `envId` references across 255 files* is not a count of
work to do; it is evidence that the host dimension is *ambient* rather than confined to a
transport layer — the fact that decides whether AppBay can add one cheaply. *Four connection
types* bounds what "a host" can be. *`join(appbayHome, aux.path)` at `route.ts:35,45`* is the
single line that makes AppBay single-host, and it is the reason SPEC-006 stages delivery
separately from transport. *Eight identity tables and an environment-scoped `can()`* versus
*three edge-user verbs* is the multi-user shape. *129,226 versus 25,550 lines, 21 versus 9
pages* is a crude instrument: it establishes an order of magnitude and says nothing about
quality.

**What would falsify it.** For M10, a Dockhand deploy path bypassing `envId`, or an AppBay
code path already reaching a non-local daemon. For M12, a page count that does not survive
excluding shared component directories.

**Known defect in this record.** One section's command path was malformed and its line
errored; the AppBay edge-user surface was captured separately and is quoted in
[F9](INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f9). Everything else in
the record ran.

**Record:** [analysis-14](raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml).
**Run:** `runs/dockhand-leads-20260924/`.

---

## M14 — the tree does not install as pinned

**Producing code:** `src/appbay-dockhand/build_appbay_sandbox.sh`.

**Inputs.** The snapshot at `9f00b579`; `pnpm` 10.29.3; Node 24.12.0.

**Procedure.** `rsync` the tree to a sandbox excluding `.git`, `.codegraph` and `.kilo`;
restore write permissions; `pnpm install --frozen-lockfile`; `pnpm build`; run the built
binary. On failure, read the error, inspect `packages/db/package.json` against the lockfile,
and grep the workflows for the failing command.

**What each number means.** *Exit 1 with `ERR_PNPM_OUTDATED_LOCKFILE … 1 dependencies were
removed: @appbay/core@workspace:*`* is the lockfile disagreeing with
`packages/db/package.json`. *`release.yml:53`* runs the same command on a `v*.*.*` tag, so the
release path fails for the same reason CI was disabled. With `--no-frozen-lockfile`:
*3 of 3 turbo packages built*, and *`dist/appbay --version` → `0.1.0-dev`*.

**What would falsify it.** A successful frozen install. A release workflow not running that
command — it was read directly at line 53.

**Records:** [action-01](raw/action-01-appbay-builds-from-the-snapshot.yaml),
[action-03](raw/action-03-appbay-builds-with-a-refreshed-lockfile.yaml).

---

## M15 — the investigation's own artifacts

**Producing code:** `src/appbay-dockhand/build_store.py`,
`src/appbay-dockhand/store_roundtrip.sh`, `src/appbay-dockhand/domain.py`,
`src/appbay-dockhand/query_work_graph.sh`,
`src/appbay-dockhand/normalise_record_paths.py`,
`src/appbay-dockhand/write_run_metadata.py`.

**Store.** `appbay-dockhand-systematic-compose-state.db` holds one row per identified gap.
Generated columns (the finding, the record, the CodeGraph blast radius) are re-derived on
every build; human columns (close or leave, which specification, why) are read back and
merged. The boundary is the builder's read-back step, and it was tested: a decision was
hand-edited to `leave` and a generated column clobbered; after rebuild the edit survived and
the generated column was restored from its record, with `audit_decision` growing 10 → 12 and
no row updated or deleted.

**Work graph.** 238 nodes and 339 edges across the claim, provenance and domain layers,
loaded into LadybugDB with *"conformance: 27 counts reconciled against the CSVs"* and an
empty `dangling_edges.csv`. Ten Cypher queries re-derive published numbers rather than only
counting rows: 16 current findings, F3's three code sites, the four disagreement edges, six
deploy paths across three products, 10 gaps split 7/3, and 12 judgements each linked to its
finding.

**Two defects in this investigation's own tooling, found and fixed.** (i) `derived:` paths
were captured absolute; because the investigation lives under a directory named `runs/`, the
projector's run-path pattern matched that first and attributed every artifact to a
non-existent run, leaving `WROTE` empty. Paths were made investigation-relative and all 92
artifacts re-hashed against their records, with **0 mismatches**; `WROTE` went 0 → 92.
(ii) Run configs written with unquoted descriptions containing `": "` were invalid YAML, and
the projector swallowed the parse error, leaving `code_version` empty without complaint.
Scalars are now quoted and all 13 configs parse.

**A tool/contract mismatch, recorded rather than worked around.** The projector reads an
inquiry row's `settles` value from the second and third body cells; under the column order
this workbook uses (`id | settles | inputs | …`) it is the first. So the `RAISES` edge from
questions to `H1` is expressed in the workbook and does not project. The table was left in
the documented order rather than rearranged to satisfy a regular expression.

**Records:** [probe-16](raw/probe-16-human-judgement-survives-a-store-rebuild.yaml),
[action-17](raw/action-17-derived-paths-normalised-without-changing-content.yaml),
[action-19](raw/action-19-work-graph-loads-and-reconciles.yaml),
[analysis-20](raw/analysis-20-published-findings-re-derived-from-the-graph.yaml),
[action-21](raw/action-21-work-graph-rebuilt-with-valid-run-configs.yaml).
