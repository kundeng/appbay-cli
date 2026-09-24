# Investigation — Is AppBay's weakness relative to Dockhand perceived or real?

## Goal

Judged as *a systematic approach to making Compose deployments easier* — a developer
should not tailor a Compose file per deployment system — does AppBay deliver, and where
does it fall short? Separate the compiler's design, its implementation maturity, and its
presentation. Confirm or refute, from Dockhand's source, that Dockhand has no runtime
overlay model.

## Summary

**The systematic approach is real, and it is AppBay's alone.** Measured, not inferred: a
stock `docker-compose.yml` — host port published, no networks, no labels — compiled
unchanged (input sha256 `571417f2` identical before and after) into a deployment with the
host port stripped, the shared network attached, identity labels stamped, namespace values
and secrets injected, and an edge route emitted, under both providers
([F1](#f1), [probe-04](raw/probe-04-untouched-compose-compiles-under-both-edges.yaml)).
Dockhand has nothing of the kind: its only compose transform is a line-regex bind-path
fixup, and every proxy string in its source is a *read* of a label the user wrote
([F2](#f2)).

The weakness is **not** in the compiler's design. It is in implementation maturity at
three specific points and in one presentation defect:

- The three sites that touch `environment:` disagree about the map form. A service written
  `environment: {KEY: value}` — valid Compose, used by four of AppBay's own shipped apps —
  silently loses every variable it declared when a `scoped-env` trait is present, and
  silently skips magic-variable generation either way ([F3](#f3)). A passing test asserts
  the loss as correct ([F4](#f4)).
- The web UI's deploy path never writes `auxiliaryFiles`, so an app deployed from the GUI
  runs with no ingress route and no authorization policy — while the plan preview lists
  the route files it will not install ([F5](#f5)).
- The code default is `ingress_provider: traefik` and the `auth` trait refuses anything but
  Caddy, so a default install cannot use the headline access-control trait ([F6](#f6)).
- The lockfile is stale, which disabled CI and now breaks the tagged-release workflow by
  the same cause ([F7](#f7)).

Dockhand leads on multi-host, GUI breadth, multi-user, and more besides; each lead's
mechanism is named in [F8](#f8)–[F10](#f10). AppBay's single-host assumption is not a
missing feature but a shape: route delivery is a local filesystem write.

Two of the prior review's recommendations are **refuted**: the docs are not 13 commands
behind (only `exec` and `run` lack a heading, [F11](#f11)), and `check-docs-cli.mjs` is not
inert — it is a sensitive check that nothing runs ([F12](#f12)).

*Where:* investigation host, macOS 25.2.0, sandbox build of `appbay-cli-mac@9f00b579` at
`workdir/scratch/appbay-sandbox`; sources read-only at `/tmp/audited-ops-eval-20260924b`.
*As of* 2026-09-24. *Still live:* every finding is a property of the pinned trees, not of a
running system; the one container started was torn down
([action-15](raw/action-15-auth-trait-error-does-not-stop-the-deploy.yaml)).
*Next action:* apply **SPEC-001** — one environment model across the compiler — starting by
inverting `scoped-env.test.ts:178`, the test that asserts the loss. The seven specifications
and the list of gaps to leave alone are in `docs/specs/`; the evidence chain is traversable
in both directions and rebuilds cleanly ([F17](#f17)).

## Scope

**Included.** `appbay-cli-mac` at `9f00b579` with its 14 uncommitted files (primary
subject); `appbay-mac` at `d8f557bc` for the web and GUI surface; `dockhand` at
`99dc1044`. Executable evidence from a sandbox build of the AppBay tree. Structural claims
about either codebase from CodeGraph.

**Excluded.** Running Dockhand — it was read, not executed; its BSL 1.1 licence and its
`envId`-parameterised architecture put a comparable end-to-end run out of proportion to
what it would add, since deliverable 2 is answered from call shape. No product change was
made; the sources were never written to. Licence, pricing and market position are out of
scope. Dockhand's Enterprise-gated features were read in source but not exercised.

**Stated limitation, carried wherever used.** [F8](#f8)–[F10](#f10) compare *named*
surfaces. A named-surface comparison cannot see a capability the other side has no name
for — AppBay's trait compiler is precisely such a capability on Dockhand's side, which is
why [F2](#f2) was settled from call shape instead of from feature names. Read those
findings as "what Dockhand has built that AppBay has not", never as a scorecard.

## Claims

| id | claim | standing | moved by |
|---|---|---|---|
| [F1](#f1) | An untailored Compose file compiles into a full deployment | ✅ settled | [probe-04](raw/probe-04-untouched-compose-compiles-under-both-edges.yaml) |
| [F2](#f2) | Dockhand has no runtime overlay model | ✅ settled | [probe-06](raw/probe-06-dockhand-has-no-compose-overlay.yaml) |
| [F3](#f3) | Map-form `environment:` is silently lost | ✅ settled | [probe-05](raw/probe-05-map-form-environment-is-handled-three-ways.yaml) |
| [F4](#f4) | A passing test asserts that loss as correct | ✅ settled | [analysis-11](raw/analysis-11-map-form-defect-is-locked-in-by-a-test.yaml) |
| [F5](#f5) | The web deploy path drops the edge route | ✅ settled | [analysis-13](raw/analysis-13-web-deploy-drops-the-edge-route.yaml) |
| [F6](#f6) | The default edge cannot run the `auth` trait | ✅ settled | [probe-04](raw/probe-04-untouched-compose-compiles-under-both-edges.yaml) |
| [F7](#f7) | The stale lockfile breaks the release workflow | ✅ settled | [action-01](raw/action-01-appbay-builds-from-the-snapshot.yaml) |
| [F8](#f8) | Dockhand's multi-host lead is an `envId` parameter | ✅ settled | [analysis-14](raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml) |
| [F9](#f9) | Dockhand's multi-user lead is env-scoped RBAC | ✅ settled | [analysis-14](raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml) |
| [F10](#f10) | Dockhand's GUI lead is an order of magnitude | ✅ settled | [analysis-14](raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml) |
| [F11](#f11) | ~~The docs name only 34 of 47 commands~~ | ❌ refuted | [probe-08](raw/probe-08-cli-exposure-top-level-commands.yaml) |
| [F12](#f12) | ~~`check-docs-cli.mjs` is inert~~ | ❌ refuted | [probe-09](raw/probe-09-docs-cli-check-detects-injected-drift.yaml) |
| [F13](#f13) | Only 4 of 47 commands emit JSON | ✅ settled | [probe-08](raw/probe-08-cli-exposure-top-level-commands.yaml) |
| [F14](#f14) | Declared shepherd vocabulary has no producer | ✅ settled | [analysis-12](raw/analysis-12-appbay-declared-but-unreachable-surface.yaml) |
| [F15](#f15) | ~~A failed `auth` trait still deploys~~ | ❌ refuted | [action-15](raw/action-15-auth-trait-error-does-not-stop-the-deploy.yaml) |
| [F16](#f16) | The suite is green while F3 is live | ✅ settled | [probe-10](raw/probe-10-appbay-test-suite-at-the-pinned-commit.yaml) |
| [F17](#f17) | The evidence chain holds; two of my own tools did not | ✅ settled | [action-17](raw/action-17-derived-paths-normalised-without-changing-content.yaml) |
| [H1](#h1) | The gap is presentation, not substance | 🟡 partly supported | [F3](#f3), [F5](#f5), [F11](#f11) |

### Thread A — does the compiler deliver the stated purpose?

<a id="h1"></a>
### H1 — AppBay's weakness is presentation, not substance
**Setting.** The two pinned AppBay trees and the pinned Dockhand tree, judged against
AppBay's stated purpose (deployment concerns declared once and compiled in), 2026-09-24.
**Role:** Result
**Claim.** Where AppBay looks weaker than Dockhand, the cause is how the product is
presented and documented rather than what the code does.
**Where it stands.** Partly supported, and the split is the answer to the question. The
*compiler's design* is sound and unique ([F1](#f1), [F2](#f2)). Presentation is in better
shape than the prior review believed ([F11](#f11), [F12](#f12)). But three implementation
defects are substance, not presentation: silent environment loss ([F3](#f3)), a GUI deploy
that drops the product's headline output ([F5](#f5)), and a default edge that cannot run
the headline trait ([F6](#f6)). So: design real, presentation adequate, maturity the gap.
**Evidence:** the three axes are separated in the report's *Perceived or real* section —
[REPORT](REPORT-2026-09-24-appbay-dockhand-systematic-compose.md#perceived-or-real).

<a id="f1"></a>
### F1 — An untailored Compose file compiles into a full deployment
**Setting.** One app, `demo`, two services, in a scratch `APPBAY_HOME`; compiled once per
ingress provider with `appbay compile demo` from a sandbox build of `9f00b579`.
**Role:** Result
**Claim.** A stock upstream Compose file, carrying nothing AppBay-specific, plus a sidecar
`appbay.yaml`, compiles into a deployment with ingress, exposure, env, secrets and identity
applied — and the Compose file itself is not modified.
**Where it stands.** Settled by execution. The input published `8080:80`, named no networks
and carried no labels. The render stripped the ingress port, attached `appbay_shared` with
alias `demo_web`, stamped `com.appbay.app`/`com.appbay.namespace` and `container_name`,
injected `TEAM=platform` from the namespace store, wired `API_TOKEN=${API_TOKEN}`, generated
a 24-character `ADMIN_PASSWORD`, and emitted `traefik/config/dynamic/demo.yml` (Traefik) or
a `demo.caddy` site block plus an authorization policy (Caddy). This is the mechanism the
whole product rests on and it works end to end.
**Evidence:** input sha256 `571417f282386e77e32d956fde779272be65a11c8e4db83c0e4b18ebb6326404`
identical after both compiles — [probe-04](raw/probe-04-untouched-compose-compiles-under-both-edges.yaml)

<a id="f3"></a>
### F3 — A map-form `environment:` silently loses every variable it declared
**Setting.** One app, two services identical but for how `environment:` is spelled, each
carrying a pre-existing variable and a magic variable, each with `scoped-env` and `secrets`
declared; compiled with `appbay compile mapform`.
**Role:** Result
**Claim.** Compose accepts `environment:` as a list or a map; AppBay's compiler handles the
two differently at three sites, and the map form loses data without a warning.
**Where it stands.** Settled by execution, and it is the most serious defect found. The
list-form service kept `KEEP_ME=important`, generated `GEN_PASSWORD`, and gained `TEAM` and
`API_TOKEN`. The map-form service rendered `environment: [TEAM, API_TOKEN]` only —
`KEEP_ME` and `GEN_PASSWORD` gone — and the compile reported `1 compiled, 0 error(s)`. The
generated-values store holds one entry, for the list-form service alone. Cause:
`compiler/compile.ts:1019` skips non-arrays (`if (!Array.isArray(svc.environment)) continue`)
so no magic variable resolves, and `traits/definitions/scoped-env.ts:34` replaces a
non-array with `[]` (`Array.isArray(svc.environment) ? svc.environment : []`), discarding
it. `traits/definitions/secrets.ts:94` handles array, object and absent correctly, so the
disagreement is internal. Four shipped system apps use the map form — `nextcloud`,
`jellyfin`, `homeassistant`, `sysinfo` — and none declares `scoped-env` today, so the
destructive path is armed rather than fired in the shipped catalog.
**Evidence:** rendered `mapform` service lost `KEEP_ME=important` and `GEN_PASSWORD` with
zero errors — [probe-05](raw/probe-05-map-form-environment-is-handled-three-ways.yaml)

<a id="f4"></a>
### F4 — A passing test asserts the loss as correct behaviour
**Setting.** `packages/core/src/traits/definitions/__tests__/scoped-env.test.ts` in the
pinned tree, read against the behaviour F3 measured.
**Role:** Check
**Claim.** The environment loss in F3 is not merely untested; it is asserted as the
expected result, which is why 1,551 passing tests do not catch it.
**Where it stands.** Settled. The final case is titled *"treats object-form environment as
empty array (does not merge)"*, comments that "object-form env is not merged", and asserts
`expect(svc.environment).toEqual(["NEW_VAR=new-value"])`. The sibling trait's suite asserts
the opposite for the same construct: `secrets.test.ts:177` passes
`{DB_PASSWORD: "placeholder", OTHER: "keep"}` and expects `OTHER` retained. This is the
signature of a test written to describe what the code does rather than what it should do.
Fixing F3 therefore requires deleting or inverting this test, which is why its blast radius
matters: CodeGraph reports four callers of `scopedEnvTraitDefinition`, two of them tests
and two barrel re-exports, so nothing else depends on the behaviour.
**Evidence:** the test title and its `toEqual(["NEW_VAR=new-value"])` assertion —
[analysis-11](raw/analysis-11-map-form-defect-is-locked-in-by-a-test.yaml)

<a id="f16"></a>
### F16 — The test suite is green at the commit where F3 is live
**Setting.** `pnpm turbo test` on the sandbox build of `9f00b579` including its 14
uncommitted files.
**Role:** Check
**Claim.** AppBay's own suite passes completely, so suite colour is not evidence about the
defects in this report.
**Where it stands.** Settled. 5 of 5 turbo tasks succeeded; `@appbay/core` 85 files,
1,148 passed and 1 skipped; `@appbay/cli` 29 files, 403 passed. Zero failures, alongside
the live data loss in [F3](#f3). Read together with [F4](#f4), the suite is green partly
*because* the defect is asserted.
**Evidence:** `Tasks: 5 successful, 5 total`, 1,551 tests passed —
[probe-10](raw/probe-10-appbay-test-suite-at-the-pinned-commit.yaml)

<a id="f6"></a>
### F6 — The default edge cannot run the `auth` trait
**Setting.** A scratch install with no `ingress_provider` key, so
`DEFAULT_INGRESS_PROVIDER` at `packages/core/src/schemas/instance.ts:72` applies; one app
declaring `auth` and `ingress`.
**Role:** Result
**Claim.** On an install that accepted the code default, declaring the `auth` trait fails
the compile.
**Where it stands.** Settled by execution, confirming what the prior review inferred but
never ran. The default is `traefik`; `traits/definitions/auth.ts:77` returns an error
unless the provider is `caddy`. `appbay compile demo` exits 1 with *"The auth trait requires
the Caddy Security edge."* This is a genuine design decision badly defaulted: Traefik is a
supported ingress and an unsupported authenticator, and the default lands on it. The
quickstart shows both providers, so a reader can land either way.
**Evidence:** `exit=1`, `[demo] apply-traits: The auth trait requires the Caddy Security edge` —
[probe-04](raw/probe-04-untouched-compose-compiles-under-both-edges.yaml)

<a id="f15"></a>
### F15 — ~~An app whose `auth` trait failed is still deployed and routed~~
**Setting.** Default-provider install, app declaring `auth` + `ingress`, real Docker
29.4.0, `appbay up authgap`.
**Role:** Result
**Claim.** ~~Because `compile` writes artifacts despite errors, `up` brings the app up
without its authorization policy.~~
**Where it stands.** ❌ **Refuted, and the refutation is a credit to AppBay.** `appbay up`
exited 1 with *"not deployed: its configuration did not compile … Deploying it would start
a container that cannot serve its declared routes."* `docker ps` by label returned nothing;
no route file and no policy were written. The per-app gate is `deploy-service.ts:154-164`
(`appsWithCompileErrors` → `refusalOf`). Killing evidence: the empty `running.txt`,
`routes.txt` and `policies.txt` captures. `appbay compile` does still write artifacts
alongside its non-zero exit, but `compile` is a preview command and `up` does not trust it.
**Evidence:** zero containers, zero route files, exit 1 —
[action-15](raw/action-15-auth-trait-error-does-not-stop-the-deploy.yaml)

### Thread B — Dockhand's overlay model

<a id="f2"></a>
### F2 — Dockhand has no runtime overlay model
**Setting.** `dockhand@99dc1044`, all of `src/`, the path from `deployStack` to the
`docker compose` spawn; CodeGraph for call shape, grep for whether a string is ever written.
**Role:** Result
**Claim.** Nothing in Dockhand takes a plain Compose file and systematically adds
deployment concerns; it applies the file as written.
**Where it stands.** Settled from source, confirming the prior review's manual-based
judgement. Compose content is reassigned at exactly two points between `deployStack` and
the spawn — `stacks.ts:1258` (`rewriteComposeVolumePaths`, `host-path.ts:566`) and
`stacks.ts:1279` (`rewriteBindsToHostDir`). Both are line-regex rewrites of relative
bind-mount paths so that a Dockhand running inside a container names paths the host daemon
can resolve; neither parses YAML and neither adds a deployment concern. Dockhand's only
other layering is environment variables — a `.env.dockhand` override file for git stacks
plus secrets injected into the spawn environment. On proxies it is strictly a *reader*:
every `traefik.http.routers` occurrence is a `labels[...]` lookup in `utils/traefik-urls.ts`
or UI prose, and `traefik.enable`, `certresolver`, `acme`, `letsencrypt` and `forward_auth`
occur zero times in `src/`. `utils/caddy-urls.ts` likewise parses `caddy-docker-proxy`
labels to render a clickable URL. **Set aside from here: the category is AppBay's alone.**
**Evidence:** two compose-content reassignments, both bind-path fixups; zero proxy-config
producers — [probe-06](raw/probe-06-dockhand-has-no-compose-overlay.yaml)

### Thread C — where Dockhand goes further

<a id="f8"></a>
### F8 — Dockhand's multi-host lead is an `envId` parameter, not a subsystem
**Setting.** `dockhand@99dc1044` `src/`, versus `appbay-cli-mac@9f00b579`
`packages/core/src/runtime` and `services/deploy`.
**Role:** Result
**Claim.** Dockhand supports many hosts because every data access and every Docker call
carries a host id; AppBay cannot because its transport is a local process spawn and its
route delivery is a local file write.
**Where it stands.** Settled, and the mechanism is what a maintainer needs. Dockhand stores
each host as an `environments` row (host, port, protocol, TLS material, `connectionType` of
`socket` | `direct` | `hawser-standard` | `hawser-edge`, plus agent fields) and threads
`envId` through 2,822 references across 255 files; the transport is `dockerFetch(path,
opts, envId)` at `docker.ts:789` — the Docker HTTP API. AppBay's `containerExec`,
`containerSpawnSync`, `containerSpawn` and `containerCompose` take `appbayHome` and spawn a
**local** binary; none takes a host. The deeper constraint is not the spawn layer but
delivery: `services/deploy/route.ts:35,45` install every route and policy with
`join(appbayHome, aux.path)`, a local filesystem write that the edge container reads
through a bind mount, and Caddy validation is a `containerExec` into a local container.
`traits/types.ts:5-6` states the assumption in words. CodeGraph puts 67 symbols in
`containerBin`'s impact set, which bounds the spawn-layer half of the work.
**Evidence:** 2,822 `envId` references and an HTTP transport versus a local spawn and
`join(appbayHome, aux.path)` — [analysis-14](raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml)

<a id="f9"></a>
### F9 — Dockhand's multi-user lead is environment-scoped RBAC with an audit trail
**Setting.** Dockhand's `db/schema/index.ts` and `server/authorize.ts`, versus AppBay's
`appbay edge users` surface and RFC-001 §1.
**Role:** Result
**Claim.** Dockhand models users, roles and per-environment authorization in its own
database; AppBay deliberately owns no accounts and delegates identity to the edge.
**Where it stands.** Settled. Dockhand has `users`, `sessions`, `roles`, `userRoles`,
`ldapConfig`, `oidcConfig`, `apiTokens` and `auditLogs`; `roles.environmentIds` scopes a
role to a host set and `userRoles` is unique on (user, role, environment). One gate,
`authorize(cookies)`, exposes `can(resource, action, environmentId)` and
`canAccessEnvironment(environmentId)`; RBAC is licence-gated (5 `isEnterprise` checks).
AppBay's whole surface is `appbay edge users list | create | reset-password`, with roles
expressed as the `group` property on the `auth` trait. The difference is architectural
intent, not an oversight — RFC-001 §1 made the edge the sole identity authority — but it
means AppBay has no per-operator authorization and no record of who changed what.
**Evidence:** eight identity tables and an env-scoped `can()` versus three edge-user verbs —
[analysis-14](raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml)

<a id="f10"></a>
### F10 — Dockhand's GUI lead is an order of magnitude, and it is the product
**Setting.** Dockhand `src/routes` + `src/lib/components`, versus `appbay-mac@d8f557bc`
`apps/web/src`.
**Role:** Contrast
**Claim.** Dockhand's interface is roughly five times AppBay's by volume and covers
materially more of the Docker surface.
**Where it stands.** Settled, with the caveat that volume is a crude instrument and the
AppBay snapshot is six weeks older. Dockhand: 700 files, 129,226 lines, 21 top-level pages
(activity, alerts, audit, backups, containers, dashboard, environments, images, logs,
metrics, networks, profile, registry, schedules, settings, stacks, templates, terminal,
volumes …) and 266 API route handlers. AppBay web: 136 files, 25,550 lines, 9 pages (apps,
auth, catalog, deploy, doctor, login, secrets, settings, setup). The asymmetry is
purposeful — Dockhand's GUI *is* the product, AppBay's is a companion to a CLI — but it
sets what "GUI convenience" costs to close.
**Evidence:** 129,226 versus 25,550 lines; 21 versus 9 pages —
[analysis-14](raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml)

### Thread D — implementation maturity and exposure

<a id="f5"></a>
### F5 — No web deploy path installs the edge route or the authorization policy
**Setting.** `appbay-mac@d8f557bc` `apps/web/src/server`, the only web snapshot available
(2026-08-09, six weeks behind the CLI tree).
**Role:** Result
**Claim.** An app deployed from AppBay's web UI starts without the ingress route and
authorization policy its manifest declares.
**Where it stands.** Settled, and it is the defect that most undercuts the product's stated
purpose, because the friendlier surface drops exactly the concerns the compiler exists to
add. `compile()` returns `rendered` **and** `auxiliaryFiles`; `auxiliaryFiles` appears
exactly once anywhere under `apps/web/src` — `routers/plans.ts:112`, which maps it to bare
paths for the plan preview. So the UI *shows* the operator the route files, then
`deployments.up` (`routers/deployments.ts:159`) compiles, writes only
`docker-compose.rendered.yml`, and spawns `docker compose up -d`. The queue's
`workers/deploy.ts` does the same. `fullDeploy` — the one procedure whose docstring claims
"feature parity with `appbay up`" and which does call core's `deployPipeline` — has **zero**
call sites outside the server, while `deployments.up` has four. The web server also
hardcodes `"docker"` at 16 spawn sites against the CLI's single `containerBin(appbayHome)`
resolver, so a `container_runtime: podman` install is broken in the UI by construction; and
it calls `compile({activeApps})`, an option the current core deliberately removed, so the
two halves no longer share an API.
**Evidence:** one `auxiliaryFiles` reference under `apps/web/src`, display-only; `fullDeploy`
with 0 UI call sites — [analysis-13](raw/analysis-13-web-deploy-drops-the-edge-route.yaml)

<a id="f7"></a>
### F7 — The stale lockfile disabled CI and now breaks the release workflow
**Setting.** `appbay-cli-mac@9f00b579`, `pnpm install --frozen-lockfile` at the repo root.
**Role:** Result
**Claim.** The pinned `pnpm-lock.yaml` does not match `packages/db/package.json`, so every
workflow that installs with `--frozen-lockfile` fails.
**Where it stands.** Settled on the first command of the investigation. The install exits 1
with `ERR_PNPM_OUTDATED_LOCKFILE`: the lockfile still lists `@appbay/core` as a dependency
of `packages/db`, which that package no longer declares. The team diagnosed this and
responded by moving `ci.yml` to `.github/workflows.disabled/`, documenting the cause and
the one-command fix in that directory's README. What the README does not say is that
`release.yml` — still live, triggered on `v*.*.*` — runs the same
`pnpm install --frozen-lockfile` at line 53. So the project cannot cut a tagged release at
this commit. With the lockfile refreshed, everything builds: 3 of 3 turbo packages, and
`dist/appbay --version` prints `0.1.0-dev`.
**Evidence:** `ERR_PNPM_OUTDATED_LOCKFILE … 1 dependencies were removed: @appbay/core@workspace:*`;
`release.yml:53` — [action-01](raw/action-01-appbay-builds-from-the-snapshot.yaml),
[action-03](raw/action-03-appbay-builds-with-a-refreshed-lockfile.yaml)

<a id="f11"></a>
### F11 — ~~The docs name only 34 of 47 shipped commands~~
**Setting.** The built binary's own `--help`, top-level names only, against
`docs/reference/cli-commands.qmd` in the same tree.
**Role:** Check
**Claim.** ~~13 shipped commands are never named in the documentation.~~
**Where it stands.** ❌ **Refuted.** `appbay --help` prints 51 top-level names; 4 are
retirement notices (`admin`, `auth`, `authelia`) plus commander's built-in `help`, leaving
**47 real commands** — the prior review's shipped count is right. But **46 of them have a
heading** in `docs/reference/cli-commands.qmd`; only `exec` and `run` do not. The
uncommitted changes to that file edit two existing sections and add no headings, so the
docs were already complete at `9f00b579`. Killing evidence: the `comm -23` of help against
doc headings yields exactly `exec run`. The prior figure was measured against some other
surface, most likely the README command table.
**Evidence:** 47 real commands, 46 documented, gap = `exec`, `run` —
[probe-08](raw/probe-08-cli-exposure-top-level-commands.yaml)

<a id="f12"></a>
### F12 — ~~`scripts/check-docs-cli.mjs` is inert~~
**Setting.** The script run from the sandbox repo root, then run again against two
deliberately injected discrepancies in the sandbox copy of `cli-commands.qmd`.
**Role:** Check
**Claim.** ~~The docs/CLI consistency check does not actually check anything.~~
**Where it stands.** ❌ **Refuted by mutation test.** Baseline: exit 0, "51 commands, 28
docs files scanned, 0 discrepancies". Injecting a documented-but-absent command
(`appbay teleport`) produced 2 discrepancies and exit 1; injecting a documented-but-absent
flag (`appbay status --telepathy`) produced 1 discrepancy and exit 1; restoring the file
returned it to exit 0. The checker is sensitive to both failure classes it claims to catch.
The prior review's first run almost certainly hit the `✖ binary not found` path (exit 2)
from the wrong working directory, as this investigation did before correcting it. The real
problem is adjacent and worth acting on: this working check is not wired to anything,
because CI is disabled by [F7](#f7).
**Evidence:** three-way mutation — 0 → 2 → 1 → 0 discrepancies —
[probe-09](raw/probe-09-docs-cli-check-detects-injected-drift.yaml)

<a id="f13"></a>
### F13 — Only 4 of 47 commands can emit JSON
**Setting.** Each of the 47 real top-level commands asked for its own `--help` from the
built binary; the flag match is anchored so `--json-lines`-style names cannot inflate it.
**Role:** Result
**Claim.** The CLI is almost entirely unscriptable by machine.
**Where it stands.** Settled, and worse than the prior review reported, though over a wider
population: it counted 16 of 23 *state-reporting* commands lacking `--json`, this counts all
47. Exactly four accept `--json`: `doctor`, `list`, `ps`, `status`. Every other command —
`info`, `size`, `url`, `home`, `env`, `config`, `catalog`, `presets`, `secrets`, `edge`,
`stats`, `models`, `profile`, `validate`, `compile` among them — is human-readable text only.
This is the concrete form of the prior review's "exposure" thesis and the reason an MCP
server should wait: an MCP server over text output would re-parse what the CLI already knows.
**Evidence:** `with --json: 4`, `without --json: 43` —
[probe-08](raw/probe-08-cli-exposure-top-level-commands.yaml)

<a id="f14"></a>
### F14 — Declared shepherd vocabulary has no producer and no consumer
**Setting.** `packages/core/src/traits/types.ts` against every producer and reader in
`packages/core/src`.
**Role:** Check
**Claim.** `ShepherdPhase` and `ShepherdAction` declare lifecycle vocabulary that nothing
emits and nothing runs.
**Where it stands.** Settled, low stakes, and the codebase has twice documented this exact
pattern about itself (the `warnings` channel that "had NO producers", the `wrapper-live`
injection mode "with no branch behind it"). `ShepherdPhase` is
`"pre-deploy" | "post-deploy" | "on-stop" | "cron"`. `on-stop` has zero producers and no
branch in `services/deploy/converges.ts`; `cron` has zero real producers (the one my script
counted is the doc comment at `types.ts:109` — a counting defect I corrected on reread); and
`ShepherdAction.schedule`, documented as "only for phase: cron", has zero readers in the
shepherd or deploy path. `converges.ts` runs `pre-deploy` and `post-deploy` only. Separately,
the `warnings` channel is no longer producerless — `gpu.ts:241` writes to it — so that part
of the `types.ts` commentary is now historical.
**Evidence:** `on-stop`: 0 producers, 0 runner mentions; `ShepherdAction.schedule`: 0 readers —
[analysis-12](raw/analysis-12-appbay-declared-but-unreachable-surface.yaml)

<a id="f17"></a>
### F17 — The investigation's own artifacts hold together, and two of its tools did not
**Setting.** This investigation's store, records and work graph, 2026-09-24.
**Role:** Check
**Claim.** The evidence chain is traversable in both directions and survives rebuilding;
two defects in the investigation's own tooling were found by checking rather than assumed
absent.
**Where it stands.** Settled. The store round-trip holds: an edited decision survived a
rebuild while a clobbered generated column was restored, and `audit_decision` grew 10 → 12
with nothing updated or deleted. The graph loads at 238 nodes / 339 edges with 27 counts
reconciled, an empty `dangling_edges.csv`, and ten Cypher queries re-deriving published
numbers. Two of my own defects: `derived:` paths were captured absolute and, because this
investigation lives under a directory named `runs/`, the projector attributed every artifact
to a non-existent run — fixed, with all 92 artifacts re-hashed and 0 mismatches; and run
configs containing `": "` were invalid YAML whose parse error the projector swallowed
silently, leaving `code_version` empty — fixed, all 13 now parse. One mismatch is recorded
rather than worked around: the projector reads an inquiry row's `settles` from the second
and third body cells, where this workbook's column order puts it first, so `RAISES` does not
project.
**Evidence:** 92 artifacts re-hashed, 0 mismatches — [action-17](raw/action-17-derived-paths-normalised-without-changing-content.yaml); 27 counts reconciled — [action-21](raw/action-21-work-graph-rebuilt-with-valid-run-configs.yaml)

## Probes & analyses

| id | settles | inputs | procedure | status | produced | moved |
|---|---|---|---|---|---|---|
| NP1 | F7 | snapshot at `9f00b579` | rsync to sandbox, `pnpm install --frozen-lockfile`, `pnpm build` | run | [action-01](raw/action-01-appbay-builds-from-the-snapshot.yaml) | F7 |
| NP2 | F7 | same, `--no-frozen-lockfile` | reinstall, build, smoke-check the binary | run (smoke path wrong; NP3 supersedes) | [action-02](raw/action-02-appbay-builds-with-a-refreshed-lockfile.yaml) | — |
| NP3 | F7 | same | as NP2, checking `dist/appbay` not `dist/index.js` | run | [action-03](raw/action-03-appbay-builds-with-a-refreshed-lockfile.yaml) | F7 |
| NP4 | F1, F6 | stock compose + sidecar manifest, both providers | build a scratch home per provider, `appbay compile demo`, keep render + aux files, hash the input | run | [probe-04](raw/probe-04-untouched-compose-compiles-under-both-edges.yaml), `runs/compile-untouched-20260924/` | F1, F6 |
| NP5 | F3, H1 | one app, two services differing only in env spelling | declare `scoped-env` + `secrets` on both, compile, compare renders and the value store | run | [probe-05](raw/probe-05-map-form-environment-is-handled-three-ways.yaml) | F3 |
| NP6 | F2 | `dockhand@99dc1044` `src/` | CodeGraph callees/callers for the deploy path; enumerate compose-content reassignments; grep proxy-config strings for writers | run | [probe-06](raw/probe-06-dockhand-has-no-compose-overlay.yaml) | F2 |
| NP7 | F11, F13 | built binary + docs | parse `--help`, compare to doc headings, test `--json` per command | run (two counting defects; NP8 supersedes) | [probe-07](raw/probe-07-cli-exposure-measured-from-the-binary.yaml) | — |
| NP8 | F11, F13, H1 | same | top-level names only, retirement notices subtracted, anchored `--json` match, docs check from the repo root | run | [probe-08](raw/probe-08-cli-exposure-top-level-commands.yaml) | F11, F13 |
| NP9 | F12 | sandbox copy of `cli-commands.qmd` | baseline; inject absent command; inject absent flag; restore | run | [probe-09](raw/probe-09-docs-cli-check-detects-injected-drift.yaml) | F12 |
| NP10 | F16 | sandbox build | `pnpm turbo test` | run | [probe-10](raw/probe-10-appbay-test-suite-at-the-pinned-commit.yaml) | F16 |
| NP11 | F4 | the three env sites + their tests | CodeGraph impact/callers per symbol; read the asserting test; classify shipped manifests by env form | run | [analysis-11](raw/analysis-11-map-form-defect-is-locked-in-by-a-test.yaml) | F4 |
| NP12 | F14 | `traits/types.ts` vocabulary | count producers and readers per member; CodeGraph callers for exported compiler symbols | run | [analysis-12](raw/analysis-12-appbay-declared-but-unreachable-surface.yaml) | F14 |
| NP13 | F5, H1 | `appbay-mac` web server | enumerate deploy paths; grep `auxiliaryFiles` under `apps/web/src`; count UI call sites per procedure; count hardcoded runtimes | run | [analysis-13](raw/analysis-13-web-deploy-drops-the-edge-route.yaml) | F5 |
| NP14 | F8, F9, F10 | both trees | per lead, name the implementing code and AppBay's counterpart or absence | run (one malformed path; that line captured separately) | [analysis-14](raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml) | F8, F9, F10 |
| NP15 | F15 | default-provider install, real Docker | `appbay up` an app whose `auth` trait errors; observe containers, routes, policies; tear down | run | [action-15](raw/action-15-auth-trait-error-does-not-stop-the-deploy.yaml) | F15 (refuted) |
| NP16 | F17 | the store builder | hand-edit a decision, clobber a generated column, rebuild, compare | run | [probe-16](raw/probe-16-human-judgement-survives-a-store-rebuild.yaml) | F17 |
| NP17 | F17 | 12 records with absolute derived paths | rewrite the prefix to investigation-relative, then re-hash all 92 artifacts | run | [action-17](raw/action-17-derived-paths-normalised-without-changing-content.yaml) | F17 |
| NP18 | F17 | the claim/provenance/domain projection | build CSVs and load LadybugDB | run (engine refused a multi-pair COPY; NP19 supersedes) | [action-18](raw/action-18-work-graph-loads-and-reconciles.yaml) | — |
| NP19 | F17 | same, one domain label per bridge type | rebuild and reconcile counts | run | [action-19](raw/action-19-work-graph-loads-and-reconciles.yaml) | F17 |
| NP20 | F17 | the loaded graph | re-derive ten published numbers with Cypher | run | [analysis-20](raw/analysis-20-published-findings-re-derived-from-the-graph.yaml) | F17 |
| NP21 | F17 | same, with parseable run configs | rebuild after quoting the config scalars | run | [action-21](raw/action-21-work-graph-rebuilt-with-valid-run-configs.yaml) | F17 |
| NP22 | F17 | the workbook and the records | generate each study page's facts block between its markers | run | [analysis-22](raw/analysis-22-study-facts-generated-from-the-workbook.yaml) | F17 |

## Worknotes

**2026-09-24 — capabilities at session start.**
[probe-00](raw/probe-00-capabilities.yaml) records the starting surface: `audit.py` on
Python 3.10.9, with `jq`, `yq`, `curl` and `git` present. Three capabilities were missing
and were fixed rather than routed around, each recorded: the sources could not be executed
(no `node_modules`, read-only) — resolved by the sandbox build; the graph engine would not
import under the x86_64 Python (it wants an Intel `openssl@3` that is not installed) —
resolved with an arm64 virtualenv at `scratch/graphvenv`; and `codegraph` was already on
PATH with all three repositories indexed, which every structural claim relies on.

**2026-09-24 — sources are unwritable and carry no `node_modules`.** Nothing could be
executed in place, and the brief forbids copying a repository into the investigation record.
Resolved by building at `workdir/scratch/appbay-sandbox`, under the working directory but
outside `investigations/`. The snapshots were never written to; every source read is by
absolute path. Rollback is `rm -rf workdir/scratch`.

**2026-09-24 — `audit.py --run-dir` resolves against `$PWD`, not `$AUDIT_DIR`.** NP4 was
recorded with a relative `--run-dir`, so its full log landed at `workdir/runs/…` rather
than inside the investigation. Moved into place (content unchanged) and every later record
passed an absolute `--run-dir`. Also observed: the helper deletes the stdout log when the
output is not truncated, and always deletes the stderr log, so stderr survives only in the
record's capped `stderr:` field.

**2026-09-24 — `apps/cli` builds a Bun-compiled binary.** `bun build --compile` emits
`dist/appbay`, not `dist/index.js`; NP2's smoke check looked for the wrong path. Bun-compiled
CLIs can drop piped stdout past 64 KB, so every capture here redirects to a regular file,
which is what `rec` does by default.

**2026-09-24 — two counting defects in my own code, found on reread.** NP7 used
`grep -c 'json$'`, which also matches `no-json` (51 + 47 = 98 over 51 commands), and swept
subcommand names out of every `commands/*.ts` into the "declared" population. NP8 replaces
it with an anchored match over top-level names only. NP12 counted a doc comment as a
producer of `phase: "cron"`. Both are recorded rather than silently corrected because the
superseded records are cited in NP rows.

**2026-09-24 — an exit code I misread.** `appbay admin | head` reported exit 0, which is
`head`'s status. Retested directly: `admin`, `auth` and `authelia` all exit 1, so
`retired.ts:101` honours its stated invariant. No finding.

**2026-09-24 — untracked `.kilo/worktrees/fixed-chili/` in the working tree.** 489 files, a
stale full copy of the repo, untracked and not covered by `.gitignore` at the root. CodeGraph
did **not** index it (338 indexed files, zero from `.kilo`), so no structural claim here is
polluted by it. Housekeeping, not a finding.

**2026-09-24 — a stale cross-reference pair.** `apps/cli/src/commands/edge.ts:42` and `:74`
tell the operator that AppBay control-plane accounts are managed with `appbay admin`;
`appbay admin` exists only to say RFC-001 §1 deleted those accounts. Pre-existing (the
uncommitted diff touches only imports and the `migrate` ownership check). Small, real,
listed in the report's refactoring section.

**2026-09-24 — two helpers expect a different workbook schema than the skill documents.**
`work-graph.py` reads an inquiry row's `settles` from the second and third body cells;
under the documented order (`id | settles | inputs | procedure | status | produced |
moved`) it is the first, so the `RAISES` edge is expressed in the workbook and does not
project. `study-map.py` matches rows as `| NPnn | status | settles | text |` and hardcodes
a `U0`..`U9` thread vocabulary, reporting "21 rows, 0 ran, 0 placed on a page" here. The
tables were left in the documented order and the facts generated by
`src/appbay-dockhand/study_facts.py` instead; rearranging real artifacts to satisfy a
regular expression would be the wrong trade.

**2026-09-24 — the product spells its own name two ways in one config tree.** Measured in
NP4's artifacts: the ingress trait and the renderer emit `# Generated by Appbay`, the auth
trait emits `# Generated by AppBay`, and on a Caddy install both land under
`etc/apps/caddy/config/`. Confirms the prior review's observation by execution.

## Files

| file | what it proves |
|---|---|
| [action-01](raw/action-01-appbay-builds-from-the-snapshot.yaml) | `--frozen-lockfile` fails at the pinned commit; release.yml runs that command |
| [action-02](raw/action-02-appbay-builds-with-a-refreshed-lockfile.yaml) | install and build succeed; the smoke check used the wrong artifact path |
| [action-03](raw/action-03-appbay-builds-with-a-refreshed-lockfile.yaml) | the sandbox CLI runs, making every later execution claim possible |
| [probe-04](raw/probe-04-untouched-compose-compiles-under-both-edges.yaml) | an untailored compose compiles to a routed deployment; the default edge fails the auth trait |
| [probe-05](raw/probe-05-map-form-environment-is-handled-three-ways.yaml) | map-form `environment:` loses its variables with no error |
| [probe-06](raw/probe-06-dockhand-has-no-compose-overlay.yaml) | Dockhand's only compose transform is a bind-path fixup; it never writes proxy config |
| [probe-07](raw/probe-07-cli-exposure-measured-from-the-binary.yaml) | superseded exposure count; retained for the NP7 row |
| [probe-08](raw/probe-08-cli-exposure-top-level-commands.yaml) | 47 commands, 46 documented, 4 with `--json` |
| [probe-09](raw/probe-09-docs-cli-check-detects-injected-drift.yaml) | the docs/CLI checker detects both drift classes it claims to |
| [probe-10](raw/probe-10-appbay-test-suite-at-the-pinned-commit.yaml) | 1,551 tests pass while F3 is live |
| [analysis-11](raw/analysis-11-map-form-defect-is-locked-in-by-a-test.yaml) | a passing test asserts the loss; blast radius is four callers |
| [analysis-12](raw/analysis-12-appbay-declared-but-unreachable-surface.yaml) | `on-stop`, `cron` and `ShepherdAction.schedule` have no producer or reader |
| [analysis-13](raw/analysis-13-web-deploy-drops-the-edge-route.yaml) | no web deploy path writes `auxiliaryFiles`; `fullDeploy` is unreachable from the UI |
| [analysis-14](raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml) | each Dockhand lead named with the code that implements it |
| [action-15](raw/action-15-auth-trait-error-does-not-stop-the-deploy.yaml) | `appbay up` refuses an app that did not compile; nothing was left running |
| [probe-16](raw/probe-16-human-judgement-survives-a-store-rebuild.yaml) | a hand-edited decision survives a store rebuild while generated columns refresh |
| [action-17](raw/action-17-derived-paths-normalised-without-changing-content.yaml) | all 92 derived artifacts re-hash to their recorded sha256 after the path rewrite |
| [action-18](raw/action-18-work-graph-loads-and-reconciles.yaml) | LadybugDB refuses an unnamed bulk COPY into a multi-pair relationship table |
| [action-19](raw/action-19-work-graph-loads-and-reconciles.yaml) | the graph loads with 27 counts reconciled and no dangling edges |
| [analysis-20](raw/analysis-20-published-findings-re-derived-from-the-graph.yaml) | ten Cypher queries reproduce the numbers this workbook publishes |
| [action-21](raw/action-21-work-graph-rebuilt-with-valid-run-configs.yaml) | every run carries its code version once the config scalars are quoted |
| [analysis-22](raw/analysis-22-study-facts-generated-from-the-workbook.yaml) | study facts are generated from the workbook, and study-map.py cannot read this schema |
| [probe-00](raw/probe-00-capabilities.yaml) | the surface at session start, and which capabilities had to be built |
