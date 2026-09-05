# Seam review — appbay-cli, read for the stackbay rewrite

**Date:** 2026-09-05. **Scope:** `packages/core/src`, `apps/cli/src`, `scripts/`, `tests/`.
Not read: `apps/web` (not in this tree), `packages/db`, trait bodies beyond the cited lines.

**Why.** One file reviewed line by line ([review-ledger.md](review-ledger.md) rows 1–12) showed
that this codebase's defects are seam defects: a fact owned in one module and answered again in
another, an outcome reported without an observation, an unknown encoded as a negative. A per-file
review finds those late. This review reads by seam, across files, and writes what stackbay must do
differently. Its lessons file is `stackbay/docs/design/lessons-paid-for.md`; L1–L8 there already
carry what the RFC history taught. The sections below name what they do not yet carry.

**How.** Three read-only sweeps (runtime boundary, result and error typing, ownership and
duplication), each returning file:line tables. Every claim below marked *verified* was re-read on
the named lines or produced by a command quoted here; *sweep* means a count from a sweep table that
was spot-checked but not re-derived; *reasoned* means it follows from reading and was not run.

---

## Finding 0 — live defect: the deploy path execs into a container that no longer exists

**Verified by running the compiler** (scratch home, `compile({apps:["caddy"]})`):

```
container_name: appbay.system.caddy.caddy
```

The three system apps declare `namespace: system` since 0ad179a (2026-08-31), and
`upstream-transform.ts:163` applies `containerName(namespace, app, service)`. The edge is therefore
`appbay.system.caddy.caddy`. Every exec target still names the old container:

| site | literal |
|---|---|
| `services/deploy-service.ts:416` `runCaddyCommand` | `["appbay.caddy.caddy", "appbay.caddy"]` |
| `services/edge-identity-service.ts:139`, `:157` | same pair |
| `apps/cli/src/commands/setup.ts:303`, `:611` | same |
| `scripts/dev-env.sh:133`, `scripts/migrate-tier2.sh:41`, `scripts/journeys/s26-*.sh:71,91,93` | same |

`runCaddyCommand` inspects those names, finds neither, returns `unavailable`, and `deploy()` counts
the app as `startedButUnrouted` and `failed`. On any host whose edge was re-created after
2026-08-31, every app with an ingress trait deploys its container and never gets its route. The
migration path was repointed to the label (`edge-migration-service.ts:66-72`, fix 9da6a61); the
deploy path was not. No deploy journey has run since the rename: S33 and S34 cite none.

**Rule for stackbay:** a generated name has one producer and zero literals. Consumers ask the
producer (`containerName(ns, app, svc)`) or ask the runtime by label (`com.appbay.app`). L5's
`Runtime.Inspect` should accept a label selector, not a name.

---

## Seam 1 — the runtime boundary: observe by socket, mutate by compose

**What the code does.** Every runtime interaction is a `spawnSync` of the CLI binary and a parse
of its text: Go templates (`{{.State.Running}}`, `{{.Names}}`), TSV, NDJSON, pretty JSON behind a
podman banner, regexes over `--version`. Sweep, spot-checked: 80+ call sites.

| pattern | sites | verified example |
|---|---|---|
| literal `"docker"` as the binary, bypassing `containerBin()` | 12 in 6 CLI files | `commands/exec.ts:22,43,67`; `dive.ts:37` also hardcodes `/var/run/docker.sock` |
| `ps --format {{.Names}}` parsed by hand | 6 | `compile.ts:650`, `stats.ts:16`, `tunnel.ts:150`, three `findOllamaContainer` copies |
| `compose ps --format json` parsers | 2 | `deploy-service.ts:143` handles the podman banner and `Names[]`; `commands/ps.ts:51` does not, so `appbay ps` is empty on Podman |
| `inspect --format {{.State.Running}}` + `=== "true"` | 4 | `checks.ts:565`, `deploy-service.ts:421`, `setup.ts:274`, `server.ts:97` |
| `network inspect appbay_shared` as an existence test | 5 | `checks.ts:548,884`, `init.ts:321`, `setup.ts:301`, `server.ts:134` |
| `tryExec` (stdout-or-null wrapper) | 3 copies | `health/checks.ts:36`, `runtime/facts.ts:30`, `cli/utils/exec.ts:10`; only one has a timeout |
| `RuntimeProfile` bypassed by a hand-written `podman` branch | 3 | `checks.ts:531-541`, `checks.ts:660`, `init-system.ts:276` |

**Mutation without observation.** Of nine `compose up -d` or container-start sites, two look
afterwards (`deploy-service.ts:819/937`, `server.ts:261` with a curl loop). Verified:

- `commands/apply.ts:111-116` prints `deployed` on exit code 0, no crash check, no Caddy install.
  It is a second deploy path without the fixes for issues 4 and 5.
- `commands/update.ts:195-200` wraps `spawnSync` in try/catch. `spawnSync` returns status without
  throwing (proved: `status: 7`, no throw), so `done` prints on every failed pull.
- `edge-migration-service.ts:77-81`: when `ps` exits non-zero, `lines = []` and every edge port
  is reported free.
- Fourteen mutating calls discard their result entirely (sweep): `volume create` ×2, `tag`,
  `rm -f` ×4, `compose down` ×3, `network create`, `pull`, the rollback `reload`.

**What the Engine API gives instead.** Verified on this Mac: `GET /containers/json?all=1` on the
socket returns typed `State`, `Status`, `Labels` for every container, filterable by label. That
replaces the `-a` retry, the banner skip, the `Name`/`Names` normalisation, and every Go template.
`/events` reports `die`, which answers "did it stay up" without a one-shot `ps` racing the crash.
Podman serves the same compat API on its socket (reasoned; no Podman on this machine).

**Rule for stackbay.** `Runtime.Up` shells to compose, because project naming, dependency order
and recreate-on-hash live there. `Runtime.Inspect` and `Runtime.Events` speak to the socket and
return structs. No Go template string exists in the codebase. The runtime-specific socket path
is data in the adapter, not a `uid == 0` branch.

---

## Seam 2 — results, errors and unknown

**What the code does.** Sweep, spot-checked: 27 functions return `null` for "could not
determine"; 19 of them have every caller read the null as the negative verdict. 155 catch blocks;
about 105 swallow with no log and no field on the return; 14 return a value-shaped default
(`{}`, `[]`, `0`, `false`, `{ availableGb: 0 }`) that reads as a measurement.

Verified:

- `deploy-service.ts:194-206` documents "null means could not inspect, not nothing crashed" and
  returns null for both at `:205`. Both callers (`:821`, `:944`) read null as ok.
- `health/checks.ts:262-275`: `passed: true` with detail "runtime not answering". Seven checks
  do this (sweep), so `doctor --json`'s `ok` is true on an install it could not inspect.
- `schemas/instance.ts:298` `readInstanceConfigText` returns null for missing or unreadable;
  7 of 8 callers write `?? ""` and parse `{}`. A fresh install and an EACCES on `system.yaml` are
  the same thing at every site, and `container-runtime.ts:75` caches the `{}`.
- `traits/types.ts:184` `ValidationResult.valid` sits beside `errors[]` and has zero readers.
- `vault-service.ts:618/647`: wrong password, locked db, and missing binary all become `null` or
  `deleted: false`; the CLI then prints "not found".

The same file holds the correct shape: `runCaddyCommand` (`deploy-service.ts:408`) returns
`{ status: "ok" | "rejected" | "unavailable"; detail }`. Same commit as the null ones.

**Rule for stackbay.** L1 already has the three-valued `Verdict` with `Unknown` distinct from
`Failed`. Two additions:

1. *Unknown carries its cause.* `Unknown(reason)` exists; the rule is that `reason` is the
   command's stderr or the error's `%w` chain, never a paraphrase. "cannot probe" hid an
   `EACCES` here for a week (`checks.ts:500-514`).
2. *A doctor cannot be green over an unknown.* `ok` is derived from "no check is Failed AND no
   required check is Unknown". `buildDoctorJson.ok` at `checks.ts:1129` derives it from Failed only.

And the Go default does the rest: `(T, error)` cannot collapse into `if x`, and `errcheck` in CI
makes the 105 swallowed catches a build failure.

---

## Seam 3 — identity versus values

**What the code does.** `compiler/identity.ts` owns six generated names and folds the namespace
into them (RFC-001 §4, commit 885ed6f). Values, meaning the ingress hostname and env vars, are
resolved by `ScopeResolver` from run-level maps (`compile.ts:462-466`) and the namespace does not
reach them. Ledger row 10 has the full case; the summary:

- `scope-resolver.ts:50` still declares `service, environment, project`; `environment` is always
  `{}`. RFC 4.2 said collapse it. No `app` scope exists.
- 107 of 109 catalog manifests write `host: <name>.${{project.DOMAIN}}`; two `install --as`
  copies render the same vhost. The one row F49 marked as colliding still collides.
- Bypasses of `identity.ts`: `builds.ts:285` and `compile.ts:654` rebuild the container name
  without the namespace; `appbay_shared` has three named constants and about thirty literals;
  `appbay.server` is declared three times; `appbay.${appName}` as a shepherd target is built in
  three places. Finding 0 is the same seam.

**Rule for stackbay.** Identity is one package (`stack/identity`) and it produces every name the
system generates, the default ingress host included: `<stem>.<domain>` where the stem is
`app` or `ns.app`. A manifest `host:` is an override, and two apps resolving one host in a run is
a compile error naming both. The resolver's scopes are `project` (per-host values), `app`
(`NAME`, `NAMESPACE`, `STEM`, `HOST`), `service`. Nothing else. Ledger row 10 has the migration
count: 87 of 109 manifests already write the derived value.

---

## Seam 4 — ownership: one fact, one reader

Sweep, spot-checked; each row is a behaviour with more than one implementation.

| fact or behaviour | owner | other answers |
|---|---|---|
| `etc/system.yaml` / `project.yaml` | `schemas/instance.ts:225` | regex reader `init.ts:750` (legacy path only); regex scrape `instance-vars.ts:50`, `system-config.ts:57`; three shell `grep '^domain:'` |
| `.env` / `.env.local` parse | `config-service.ts:152` | `deploy-service.ts:771` and `:902` hand loops; compose's own `env_file` |
| APPBAY_HOME resolution | `cli/utils/appbay-home.ts:182` | four private copies in core (`container-runtime.ts:93`, `master-password.ts:52`, `keepass.ts:79`, `vault.ts:418`); 12 no-arg `containerBin()` sites depend on `cli/index.ts:78` publishing the env |
| `compile()` invocation | — | 5 production callers, byte-identical options, 5 copies of the same 🚨 comment; none passes `namespace` |
| "is the install healthy" | `health/checks.ts:1018` | `setup.ts:284` is a second doctor with 7 checks sharing no code; compose-version probed at 5 sites, docker-version at 3 |
| `compareSemver` | `checks.ts:46` | `update.ts` |
| `appbay.yaml` parse | `AppbayYamlSchema` | read without it at `config-service.ts:102,135` and `catalog-service.ts:177,310` |

**Rule for stackbay.** CLAUDE.md §2 rule 1 already says `stack` imports no sibling. Add the
inverse: a fact has one reader function, and the arch test greps for the second parser of any
file the loader owns. Config enters through one `Load(home) (Config, error)` and the CLI does not
publish env to make core agree with it.

---

## Seam 5 — tests that do not run the thing they name

Sweep: 7 of 96 test files mock a boundary; 4 tests assert only `toHaveBeenCalled*`. Verified
examples:

| test | what it asserts |
|---|---|
| `appbay-home.test.ts:91` "creates the config directory and writes the path" | `mkdirSync` was called |
| `docker.test.ts:152` "passes args after -f to docker compose" | `spawnSync` was called with them |
| `init-system.test.ts:79` "creates the service account as a no-login SYSTEM account" | the planned argv contains `useradd`; nothing runs |
| `deploy-converge.test.ts:242` | pins that `findCrashedServices` returns null when compose cannot be asked, which is the ambiguity in Seam 2 |

The command actions for `doctor`, `status`, `ps`, `update`, `eject` have tests only for their
pure helpers. Finding 0 went undetected because no test compiles a system app and then asks the
deploy path which container it will exec into.

**Rule for stackbay.** L6 has the principle. The mechanical form: a test that names a mutation
runs it against a real runtime in CI (Docker in the runner, Podman in a second job) or is named
for what it does test ("plans the useradd argv"). `toHaveBeenCalled` on a boundary mock is a
lint failure.

---

## Seam 6 — config planes and env as a side channel

Sweep: 21 distinct `process.env` keys read raw with `??` defaults outside the three that go
through Zod (`container-runtime.ts:106,126,146`). `cli/index.ts:79` and `init.ts:851` write
`process.env.APPBAY_HOME` so that core's private home resolvers agree with the CLI's. `server.ts:261`
hardcodes `APPBAY_SERVER_CONTAINER_RUNTIME="docker"` into a compose env.

**Rule for stackbay.** One `Config` struct, one loader, env read in one function with a schema,
handed down by `main()`. No package reads `os.Getenv` except that loader; the arch test enforces it.

---

## What to carry into `lessons-paid-for.md`

| proposed | from | already covered by |
|---|---|---|
| L9 · A generated name has one producer and no literal consumer | Finding 0, Seam 3 | partly L2 |
| L10 · Observe by socket, mutate by compose | Seam 1 | L5 has the interface, not the rule that Inspect is not a CLI parse |
| L11 · Unknown carries its cause, and a doctor is not green over it | Seam 2 | L1 has the verdict, not the derivation rule |
| L12 · Identity produces the hostname | Seam 3 | new |
| L13 · One fact, one reader; the arch test greps for the second parser | Seam 4 | new |
