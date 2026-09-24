---
thread: compiler-mechanism
rows: NP1 NP2 NP3 NP4
---

# What the trait compiler does to a Compose file it did not author

## The question, and what was seen

**Why.** AppBay's purpose is that a developer should not tailor a Compose file per
deployment system. That is a claim about a mechanism, and a prior review had described the
mechanism without ever running it. Before any comparison could mean anything, the mechanism
had to be traced from an input a developer would actually have to an artifact a runtime
would actually accept.

**How.** Build the pinned tree into a runnable CLI, then hand it a stock upstream Compose
file — host port published, no networks, no labels, nothing AppBay-specific — beside an
`appbay.yaml` declaring `ingress`, `auth`, `scoped-env` and `secrets`. Compile once per
ingress provider and keep every artifact. This is **not** a test of whether the compiler is
correct in general; it is one input traced to one result, chosen so that every stage of the
pipeline has something to do.

**What.** `src/appbay-dockhand/build_appbay_sandbox.sh` and
`src/appbay-dockhand/compile_untouched_compose.sh`; artifacts under
`runs/compile-untouched-20260924/`.

**Where.** Done. The mechanism is established and the two providers' outputs are both
retained.

## Where it stands

The compiler does what the product says it does. A Compose file that knows nothing about
AppBay became a deployment with ingress, exposure, environment, secrets and identity
applied, and the file itself was not touched — its hash is identical before and after both
compiles. The pipeline is a single pass with ordered stages, each doing one thing, and the
one place the ingress provider is branched on is a single expression in the ingress trait.
The design is sound; where this investigation later finds problems, they are in specific
stages, not in the shape.

## The analyses, in order

- **NP1–NP3** established that the tree can be run at all, and found that it cannot be
  installed as pinned: the lockfile is stale.
- **NP4** traced one untailored Compose file to a rendered deployment under both providers,
  and incidentally settled the default-edge question the prior review had raised.

## NP4 — one input, traced to its result

**Setting.** One app named `demo` with two services (`web`, `db`) in a scratch
`APPBAY_HOME`; `domain: lab.example.com`; namespace store seeding `DOMAIN` and `TEAM`;
compiled with `appbay compile demo` once with `ingress_provider: traefik` and once with
`caddy`. Population: this one manifest, not the catalog.

**What it tests.** Whether the deployment concerns an operator declares in a sidecar file
are compiled into artifacts, without the developer's Compose file being edited — and, as a
second reading of the same run, whether the two providers are genuinely interchangeable.

**Procedure.** Write a stock Compose file: `web` publishes `8080:80`, sets two environment
variables in list form, and restarts unless stopped; `db` runs Postgres with a map-form
environment and a named volume. Neither names a network, carries a label, or mentions
AppBay. Beside it write `appbay.yaml` declaring an app-level `auth` trait and, on `web`,
`ingress` (port 80, exposure both), `scoped-env` (TEAM from the namespace) and `secrets`
(one vault ref, runtime-env injection). Build a separate home per provider so neither run
can see the other's state. Compile, then capture the rendered compose, every auxiliary file
under the render directory, the generated-value store, and the SHA-256 of the input Compose
file after the run.

**Role:** Result.

**What was seen.** The rendered `web` service had its `8080:80` mapping removed, gained
`appbay_shared` with the alias `demo_web`, gained `container_name: appbay.demo.web` and the
`com.appbay.app`/`com.appbay.namespace` labels, gained `TEAM=platform` resolved from the
namespace store, gained `API_TOKEN=${API_TOKEN}` for deploy-time resolution, and had its
`${password:24}` replaced by a generated 24-character value persisted to
`generated-values.yaml`. Under Traefik the compiler emitted a router, a service pointing at
`http://demo_web:80`, and a security-headers middleware, with the host defaulted to
`demo.lab.example.com` from the install's domain — a host no file in the app declared.
Under Caddy it emitted a site block importing `auth/demo-*.caddy` above its
`reverse_proxy`, plus an authorization policy naming the same host. The input Compose file
hashed `571417f2…6404` after both runs, byte-identical to before.

**Alternatives considered.** Compiling one of the shipped system apps would have been
easier but weaker: those manifests were written against this compiler, so they cannot show
that an *untailored* file works. Using a real upstream project's Compose file would have
been stronger still but adds a network dependency and a licence question for no additional
mechanism. A hand-written file with the properties that matter — a published host port, an
absent network, no labels — is the smallest input that exercises every stage.

**The instrument, and what it cannot see.** `appbay compile` writes to the render directory
and does not contact a container runtime, so this establishes what the compiler *produces*,
not that Traefik or Caddy would accept it. The Caddy emitter's docstring records that the
zero-match glob and the ambiguous-site-address behaviours were tested against
`caddy:2-alpine`, which is the evidence for the half this run cannot reach.

**Overturning evidence.** A rendered compose whose input hash had changed, or an auxiliary
file absent under either provider, would refute it outright. A host of `demo.local` rather
than `demo.lab.example.com` would show the default-host derivation ignoring the install
domain.

**Second reading — the default edge.** The Traefik run exited **1**:
`[demo] apply-traits: The auth trait requires the Caddy Security edge.` The Caddy run
exited 0. `DEFAULT_INGRESS_PROVIDER` is `traefik`, so an install that accepted the default
cannot use the `auth` trait. The prior review inferred this from reading and never ran it;
this is the measurement.

Cites [probe-04](../../raw/probe-04-untouched-compose-compiles-under-both-edges.yaml),
[F1](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f1),
[F6](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f6),
run `runs/compile-untouched-20260924/`.

## Generated facts

<!-- generated: facts -->
*Generated by `src/appbay-dockhand/study_facts.py` from `INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md` and `raw/`. Do not edit by hand.*

#### NP1

**Settles:** F7 · **Status:** run · **Moved:** F7

**Inputs:** snapshot at `9f00b579`

**Procedure, as written:** rsync to sandbox, `pnpm install --frozen-lockfile`, `pnpm build`

**Records:**
- `raw/action-01-appbay-builds-from-the-snapshot.yaml` — **refutes**: "pnpm install --frozen-lockfile exits 1 with ERR_PNPM_OUTDATED_LOCKFILE: the lockfile still lists @appbay/core as a dependency of packages/db, which packages/db/package.json no longer declares. release.yml:53 runs that exact command, so the tag-triggered relea

**Findings moved:**
- **[F7]** The stale lockfile disabled CI and now breaks the release workflow — *settled*, role: Result
  - Setting: `appbay-cli-mac@9f00b579`, `pnpm install --frozen-lockfile` at the repo root.

#### NP2

**Settles:** F7 · **Status:** run (smoke path wrong; NP3 supersedes) · **Moved:** —

**Inputs:** same, `--no-frozen-lockfile`

**Procedure, as written:** reinstall, build, smoke-check the binary

**Records:**
- `raw/action-02-appbay-builds-with-a-refreshed-lockfile.yaml` — **inconclusive**: install and build both succeeded (3/3 turbo tasks); only the smoke check failed, because apps/cli builds a bun-compiled binary at dist/appbay and the script looked for dist/index.js. Superseded by action-03.

#### NP3

**Settles:** F7 · **Status:** run · **Moved:** F7

**Inputs:** same

**Procedure, as written:** as NP2, checking `dist/appbay` not `dist/index.js`

**Records:**
- `raw/action-03-appbay-builds-with-a-refreshed-lockfile.yaml` — **supports**: "pnpm install --no-frozen-lockfile then turbo build: 3 of 3 packages built; dist/appbay --version prints 0.1.0-dev. The only barrier to executing AppBay from the snapshot is the stale lockfile."

**Findings moved:**
- **[F7]** The stale lockfile disabled CI and now breaks the release workflow — *settled*, role: Result
  - Setting: `appbay-cli-mac@9f00b579`, `pnpm install --frozen-lockfile` at the repo root.

#### NP4

**Settles:** F1, F6 · **Status:** run · **Moved:** F1, F6

**Inputs:** stock compose + sidecar manifest, both providers

**Procedure, as written:** build a scratch home per provider, `appbay compile demo`, keep render + aux files, hash the input

**Records:**
- `raw/probe-04-untouched-compose-compiles-under-both-edges.yaml` — **supports**: "A stock compose file (host port 8080:80, no networks, no labels) compiled unchanged into a deployment: port stripped, appbay_shared attached with alias demo_web, identity labels and container_name stamped, TEAM=platform injected, API_TOKEN wired, ADMIN_PASSWO
  - runs: `runs/compile-untouched-20260924/`

**Findings moved:**
- **[F1]** An untailored Compose file compiles into a full deployment — *settled*, role: Result
  - Setting: One app, `demo`, two services, in a scratch `APPBAY_HOME`; compiled once per
- **[F6]** The default edge cannot run the `auth` trait — *settled*, role: Result
  - Setting: A scratch install with no `ingress_provider` key, so
<!-- /generated: facts -->
