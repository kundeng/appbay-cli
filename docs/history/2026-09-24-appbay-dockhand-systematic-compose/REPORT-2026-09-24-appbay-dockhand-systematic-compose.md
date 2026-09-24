# AppBay against Dockhand, judged as a systematic approach to Compose deployments

**2026-09-24.** Subjects: `appbay-cli-mac` at `9f00b579` with its 14 uncommitted files
(primary), `appbay-mac` at `d8f557bc` for the web surface, `dockhand` at `99dc1044`.
Everything below was measured against those pinned trees; the AppBay claims were measured
by *running* a build of them.

---

## The short version

AppBay's systematic approach is **real, and it has no counterpart in Dockhand**. Its
weakness relative to Dockhand is also real, but it is not where the previous review looked.
The documentation is in good shape. The compiler's design is sound. What is weak is
implementation maturity at three specific points, one of which silently destroys operator
data and one of which makes the graphical interface deploy applications without the routes
and access policies the product exists to produce.

Seven specifications follow, one per gap worth closing, plus a written list of gaps to
leave alone. The highest-value work is also the lowest-risk, which is unusual and worth
taking advantage of.

---

<a id="perceived-or-real"></a>
## Perceived or real

The question asks for three things to be told apart. They separate cleanly.

### The compiler's design: real, and the product's whole claim rests on it soundly

A stock `docker-compose.yml` — publishing a host port, naming no networks, carrying no
labels, mentioning AppBay nowhere — was compiled with a sidecar `appbay.yaml` declaring
`ingress`, `auth`, `scoped-env` and `secrets`. The result: the host port stripped, the
shared network attached with a generated alias, identity labels and a container name
stamped, a namespace value injected, a secret reference wired for deploy-time resolution,
a password generated and persisted, and a provider-specific route file emitted — with the
developer's Compose file byte-identical before and after
(`571417f2…6404`). That happened under both ingress providers from the same manifest.

This is the thing the product claims to do, and it does it. **[M1]**

The design has properties a feature list would not show. Provider selection is
installation-level rather than per-app, with a stated reason: two apps disagreeing about
the proxy would each emit valid config for a proxy that is not running, which produces no
error and no route. Overlay activation is evaluated against the full *declared* app set
rather than a `ps` snapshot, because the latter made `appbay up openwebui` and `appbay up`
compile the same manifest differently. Builds are hoisted out of the render so deployment
is "run this image" rather than "build and hope". Traits may read a sibling's *declared*
configuration but never its output, which avoids ordering dependencies by construction.
These are the marks of a design that has been corrected by contact with real failures, and
the code says so in unusually direct comments.

### Implementation maturity: this is where the gap is

Three defects, all measured.

**The compiler disagrees with itself about `environment:`.** Docker Compose accepts a list
(`["K=v"]`) or a map (`{K: v}`). Three places in AppBay's compiler touch that field and
none of them agrees with the other two. Two services identical but for that spelling were
compiled together: the list-form one kept its variables, generated its password and
received its injections; the map-form one rendered with **its declared variables gone** and
its magic variable never generated — and the command reported `1 compiled, 0 error(s)`. **[M2]**

This is the most serious finding in the report, and its second half is worse than its
first. The loss is not an untested edge case: a passing test named *"treats object-form
environment as empty array (does not merge)"* asserts it as the expected result, while the
sibling trait's test asserts the opposite for the same construct. That is why AppBay's
1,551 passing tests do not catch it. Four of the seven shipped system apps use the map
form. **[M3]**

**The web interface deploys applications without their routes.** The compiler returns two
things per app: the rendered Compose file and the auxiliary files — the edge route and the
authorization policy. Across the whole web application, `auxiliaryFiles` is referenced
exactly once, in the code that renders the *plan preview*. No deploy path writes it. So the
graphical interface shows the operator the route files in the plan, then starts the
container without them. The procedure that would do it correctly exists, is documented as
giving "feature parity with `appbay up`", and is called from nowhere in the interface. **[M4]**

**The default installation cannot use the headline access-control trait.** The code default
for the ingress provider is Traefik; the `auth` trait refuses any provider but Caddy. An
operator who accepted the defaults and declared `auth` gets a failed compile. **[M5]**

Against these, one safety property was tested and holds: an application whose configuration
did not compile is **not** deployed. `appbay up` refuses per-app with a message naming the
consequence rather than the error, and nothing was started, routed or written. That gate was
expected to fail and did not. **[M6]**

### Presentation: better than believed, with one real gap

The previous review's central claim was exposure — that thirteen shipped commands are never
named in the documentation, and that the repository's documentation checker is inert.
Measured from the built binary rather than from source, both are wrong.

The CLI ships **47** real top-level commands, which matches the previous count exactly. But
**46 of them are documented**; the two without a heading are `exec` and `run`. And the
documentation checker is not inert: injecting a documented-but-absent command made it report
two discrepancies and exit 1, injecting a documented-but-absent flag made it report one, and
restoring the file returned it to green. It is a working, sensitive check. **[M7]**

What *is* confirmed, and understated rather than overstated, is machine-readability. **Four
of 47 commands can emit JSON**: `doctor`, `list`, `ps`, `status`. Everything else is
human-readable text. This is the real form of the exposure problem, and it is upstream of
several things people want — an MCP server built over text output would re-parse what the
CLI already knows. **[M8]**

One presentation problem is worth stating because it is cheap and it is about trust: the
product spells its own name two ways in artifacts that land in the same directory. The
ingress trait and the renderer emit `# Generated by Appbay`; the auth trait emits
`# Generated by AppBay`. Both were observed in one Caddy configuration tree.

**The weakest point in this section:** the documentation figures were measured against
`docs/reference/cli-commands.qmd`. If the previous review measured the README's command
table instead, then both measurements are correct about different documents, and the
conclusion changes from "the docs are fine" to "one of the two documents is stale". That
is worth five minutes to check before acting on it.

---

## Dockhand's overlay model

**There is none.** Confirmed from source at the pinned commit, not from the manual.

Between the point a user's Compose file is read and the point `docker compose` is spawned,
Dockhand reassigns the compose content at exactly two places. Both are line-by-line regular
expression rewrites of relative bind-mount paths (`./data:/data`), so that a Dockhand
running inside a container names paths the host's daemon can resolve. Neither parses YAML.
Neither adds a deployment concern. The only other thing layered on is environment
variables: an override file for git-backed stacks, and secrets injected into the spawn
environment. **[M9]**

On proxies, Dockhand is strictly a **reader**. `traefik.enable`, `certresolver`, `acme`,
`letsencrypt` and `forward_auth` occur zero times in its source. Every occurrence of
`traefik.http.routers` is a dictionary lookup against labels the user wrote, in a module
whose job is to turn those labels into a clickable URL next to the port list. The Caddy
module does the same for `caddy-docker-proxy` labels.

So the category — take a Compose file the developer did not tailor, and compile deployment
concerns into it — is AppBay's alone, and this report says so once and sets it aside.

One nuance worth keeping, because it is the strongest argument against the finding:
Dockhand's template sources could hand a user a Compose file that already contains Traefik
labels. That would still not be an overlay model. The labels would be in the file the user
then owns and maintains per deployment target, which is exactly the tailoring AppBay exists
to remove.

---

## Where Dockhand goes further

Each lead below names the mechanism, because the mechanism is what decides whether closing
the gap is a feature, a refactor, or a change of shape.

**A limitation to carry through this whole section.** These are *named* surfaces. A
named-surface comparison cannot see a capability the other side has no name for — AppBay's
trait compiler is precisely such a capability on Dockhand's side, which is why the previous
section was settled from call shape instead. Read this as "what Dockhand has built that
AppBay has not", never as a scorecard.

### Multi-host — an ambient parameter over an HTTP transport

Dockhand stores every Docker host as a row carrying its address, protocol, TLS material, a
connection type (local socket, direct TCP, or one of two remote-agent modes) and agent
metadata. The host identifier is then threaded through essentially everything: **2,822
references across 255 files**. The transport is the Docker HTTP API, so any daemon that will
answer can be reached. **[M10]**

AppBay cannot adopt this cheaply, and the reason is not the one it appears to be. Its
transport is a local process spawn — the four spawn helpers take an installation directory
and run the local `docker` or `podman` binary, with no host parameter anywhere. That is the
*smaller* half. The larger half is delivery: AppBay installs every route and policy by
writing to the local filesystem, which the edge container reads through a bind mount, and
validates Caddy by executing inside a local container. Pointing at a remote daemon would
move the containers and leave the routes behind. The trait model states the assumption in
words: *"adapted for single-node Docker Compose."*

This is the only place where Dockhand's architecture does something AppBay's shape forbids,
which is why SPEC-006 stages it and makes stage zero a decision rather than code.

### Multi-user — a data model plus one gate

Dockhand has users, sessions, roles and user-role assignments, with roles scoped to a set
of hosts, plus LDAP, OIDC, API tokens and an audit log. Authorization runs through a single
gate asking "can this user do this action on this resource in this environment". Fine-grained
role-based access is licence-gated. **[M11]**

AppBay's entire equivalent is three commands: list, create and reset-password for edge
users, with roles expressed as a property on the `auth` trait. That is a deliberate
architectural position — its RFC-001 §1 made the edge the sole identity authority and
deleted AppBay's own accounts — and this report recommends keeping it. The honest cost is
that AppBay has no per-operator authorization and no record of who changed what.

### Graphical interface — an order of magnitude, and it is the product

Dockhand's interface is 700 files and roughly 129,000 lines across 21 top-level pages, with
266 API handlers: containers, images, volumes, networks, registries, schedules, backups,
metrics, alerts, an interactive terminal and a container file browser. AppBay's web
application is 136 files and roughly 25,500 lines across nine pages. **[M12]**

The asymmetry is purposeful. Dockhand's interface *is* the product; AppBay's accompanies a
CLI. But it sets the price of "GUI convenience", and a line count is a crude instrument —
it says the gap is an order of magnitude and nothing about quality.

### Elsewhere

Dockhand also leads on backups (37 modules around restic, covering repositories, snapshots,
retention and restore), ten scheduled maintenance tasks, git-driven deployment with webhook
auto-sync and deletion reconciliation, vulnerability scanning, notifications, registry
management, image-update tracking, and a remote agent. **[M13]**

AppBay's `backup` trait is worth singling out because its status is unusual and to the
team's credit: it compiles to metadata only, nothing runs it on a CLI-only installation,
and the deploy path says so loudly — *"backup declared but NOT SCHEDULED … Treat these apps
as UNPROTECTED."* That is a stated gap rather than a silent one, which is the right
engineering. It should not stay stated forever: two shipped manifests declare backups that
do nothing.

---

## What to do

Seven specifications, each its own file under `docs/specs/`, each with requirement, design
on existing seams, what it must not break, and how to verify.

| # | specification | closes | value | risk |
|---|---|---|---|---|
| [SPEC-001](docs/specs/SPEC-001-one-compose-environment-model.md) | One environment model across the compiler | data loss | highest | lowest |
| [SPEC-002](docs/specs/SPEC-002-one-deploy-path.md) | One deploy path for CLI and web | GUI deploys without routes | highest | medium |
| [SPEC-003](docs/specs/SPEC-003-default-edge-matches-the-trait-set.md) | Default edge supports the default traits | unusable `auth` on defaults | high | low |
| [SPEC-004](docs/specs/SPEC-004-release-path-and-a-check-that-runs.md) | A release path that works, checks that run | cannot ship | high | trivial |
| [SPEC-005](docs/specs/SPEC-005-json-output-on-reporting-commands.md) | JSON on reporting commands | unscriptable | medium | medium |
| [SPEC-006](docs/specs/SPEC-006-multi-host-as-a-compiler-target.md) | Multi-host, staged | the structural gap | high | highest |
| [SPEC-007](docs/specs/SPEC-007-backup-honest-or-implemented.md) | Backup: real or absent | a standing safety claim | medium | low |

And, equally important, [SPEC-000](docs/specs/SPEC-000-gaps-not-to-close.md) — the gaps
**not** to close, with reasons: a second identity plane (the RFC deleted it deliberately),
Docker-management breadth (a different product), a backup engine (build the declaration,
not the tool), vulnerability scanning and registry management (commodity), a remote agent
(premature until SPEC-006 stage zero is decided), and per-app git sync (the catalog is
already the right grain).

**Start with SPEC-001.** It is the only finding that destroys operator data, and its blast
radius is four callers — two of which are the tests that assert the loss.

---

## Refactoring, pinpointed

Prioritised by value against risk. Every call-shape claim is from CodeGraph; every
`file:line` is in the pinned trees.

### 1. `scoped-env.ts:34` destroys a map-form environment — and a test says that is correct

`packages/core/src/traits/definitions/scoped-env.ts:34` reads
`Array.isArray(svc.environment) ? svc.environment : []`, so a map-form environment is
replaced by an empty list and every variable in it is discarded. Callers, per CodeGraph:
**four** — `registry.test.ts`, `scoped-env.test.ts`, and two barrel re-exports. Nothing in
the product depends on the behaviour.

*Why it is a problem:* silent data loss in valid Compose. *Proposed change:* SPEC-001,
beginning by inverting `scoped-env.test.ts:178`. **Value: highest. Risk: lowest.**

### 2. `compile.ts:1019` skips magic-variable resolution on the same input

`if (!Array.isArray(svc.environment)) continue` in `resolveMagicVars`. A map-form service's
`${password:32}` is left as a literal string and no value is generated. Impact set for
`compile`: 24 symbols, of which 22 are test files. *Proposed change:* SPEC-001; the same
helper fixes both. **Value: highest. Risk: lowest.**

### 3. `deployments.ts:159` — the deploy path behind every Up button drops the compiler's output

`apps/web/src/server/routers/deployments.ts:159` compiles, writes
`docker-compose.rendered.yml`, and spawns `docker compose up -d`, never writing
`auxiliaryFiles`. `apps/web/src/server/queue/workers/deploy.ts:63` is a second
implementation doing the same. `deployments.fullDeploy` at `:420` does it correctly and has
**zero** call sites outside the server; `deployments.up` has four.

*Why it is a problem:* applications deployed from the interface have no ingress route and no
authorization policy, silently. *Proposed change:* SPEC-002 — delete both duplicates and
route every caller through `@appbay/core`'s deploy pipeline. **Value: highest. Risk: medium**
(the web tree is six weeks behind and needs an API reconciliation first).

### 4. Sixteen hardcoded `"docker"` spawn sites in the web server

Against the CLI's single `containerBin(appbayHome)` resolver, whose impact set is 67
symbols. `apps/web/src/server/routers/apps.ts` alone has five; `docker-utils.ts`,
`deployments.ts`, `shell-sessions.ts`, `doctor.ts` and three queue workers have the rest.

*Why it is a problem:* a `container_runtime: podman` installation is broken in the interface
by construction, and the CLI's `RuntimeProfile` table exists precisely so that runtime
differences live in one place. *Proposed change:* SPEC-002 item 4. **Value: high. Risk: low.**

### 5. A stale lockfile that disabled CI and now blocks releases

`pnpm-lock.yaml` still lists `@appbay/core` as a dependency of `packages/db`, which that
package no longer declares. `pnpm install --frozen-lockfile` exits 1. CI was moved to
`.github/workflows.disabled/` because of it — with a good README explaining the cause and
the one-command fix — but `.github/workflows/release.yml:53` runs the same command and is
still live on `v*.*.*` tags.

*Why it is a problem:* the project cannot cut a tagged release, and six written consistency
checks run nowhere. *Proposed change:* SPEC-004. **Value: high. Risk: trivial** — one
`pnpm install` and one `git mv`.

### 6. The default ingress provider contradicts the trait set

`packages/core/src/schemas/instance.ts:72` sets `traefik`;
`packages/core/src/traits/definitions/auth.ts:77` rejects anything but `caddy`. Three call
sites read the constant. *Proposed change:* SPEC-003, with the migration hazard (existing
homes that wrote no key) as the real work. **Value: high. Risk: low-medium.**

### 7. Declared lifecycle vocabulary with nothing behind it

`packages/core/src/traits/types.ts:88` declares `ShepherdPhase` as
`"pre-deploy" | "post-deploy" | "on-stop" | "cron"`. `on-stop` has zero producers and no
branch in the runner; `cron` has zero producers; `ShepherdAction.schedule`, documented as
"only for phase: cron", has zero readers. The runner handles two phases.

*Why it is a problem:* this codebase has been bitten twice by exactly this pattern and
documented both cases in its own comments — a `warnings` channel with no producers, and a
`wrapper-live` injection mode with no branch behind it. A third instance is a pattern, not
an accident. *Proposed change:* SPEC-007 uses `cron` and `schedule` for their stated purpose;
remove `on-stop` or give it a runner. **Value: low. Risk: trivial.**

### 8. Two spellings of the product name, in one configuration directory

`traits/definitions/ingress.ts:209` and the renderer emit `# Generated by Appbay`;
`traits/definitions/auth.ts:41` emits `# Generated by AppBay`. On a Caddy installation both
land under `etc/apps/caddy/config/`. *Proposed change:* one constant, one spelling, a lint
rule. **Value: low. Risk: trivial.**

### 9. Help text pointing at a retired command

`apps/cli/src/commands/edge.ts:42` and `:74` tell the operator that AppBay control-plane
accounts are managed with `appbay admin`. `appbay admin` exists only to print that RFC-001
§1 deleted those accounts. *Proposed change:* point at `appbay edge users`, which is the
answer the retirement notice itself gives. **Value: low. Risk: trivial.**

### 10. An untracked 489-file copy of the repository in the working tree

`.kilo/worktrees/fixed-chili/` is a stale full copy, untracked and not covered by the root
`.gitignore`. It did not pollute any analysis here — CodeGraph indexed 338 files and none of
them from `.kilo` — but it is 489 files of near-duplicate source that will confuse the next
grep. *Proposed change:* add `.kilo/` to `.gitignore` and delete the worktree.
**Value: low. Risk: trivial.**

---

## How this was established

Everything above is backed by 21 execution records in
[the workbook](INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md), each with
its command, its captured code, its output and a verdict. The AppBay claims were measured
by building the pinned tree and running it, which is the main difference from the previous
review. Dockhand was read, not run.

Two prior recommendations were refuted by measurement and one hypothesis of my own was
refuted by execution; all three are retained with their killing evidence, because a
comparison that only confirms what it expected is not worth much.

Reproduction detail, one entry per claim marker above, is in
[the supplement](SUPPLEMENT-2026-09-24-appbay-dockhand-systematic-compose.md). Every script
is in `src/appbay-dockhand/`; every artifact is under `runs/`.

**Forwarded files and their roles.** `INVESTIGATION-…md` is the claim ledger and the
authority on facts; this report cites it and yields to it. `SUPPLEMENT-…md` gives
reproduction detail and depends on the records under `raw/`. `docs/specs/SPEC-000..007` are
the actionable output and depend on this report's findings. `docs/studies/` explains the
threads without adding claims. `docs/PLAN-…md` carries the single next action.
