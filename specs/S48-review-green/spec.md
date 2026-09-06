---
spec_id: S48-review-green
status: ACTIVE
closed_as: null
since: 2026-09-06
until: null
epic: correctness
features: [restart-through-deploy, journeys-workdir, cli-spawns-through-runtime, scheduled-findings-closed, review-rounds]
supersedes: []
superseded_by: null
depends_on: [S47-converge-chain]
anchors: [data-architecture]
---

# S48: fix what the reviews already found, then review again until a round comes back clean

# 1 · Requirements

Kun, 2026-09-06: not ready for a human review; the open rows and the two dated review sets
hold findings that were scheduled and never taken, and the agent waited to be told each one
was a defect. This sprint takes every finding that is fixable in this tree without an owner
decision or an external resource, then runs internal review rounds over the deploy path and
its callers, fixing what each round finds, until a round returns nothing above LOW.

## Mental model

- **Green** means: every SCHEDULE disposition in `docs/history/*-review/03-CODE_QUALITY.md`
  and every open ledger row is closed or carried to a named sprint; a fresh review round
  over the deploy path and the CLI commands that reach it finds nothing above LOW; core and
  CLI tests, `tsc`, the arch rules, the repo's `check:*` scripts, and the deploy-reporting,
  apply-success and lifecycle journeys on both Lima guests pass.
- **Not in this sprint, with the destination named:** the config loader that replaces 34 raw
  `process.env` reads (S49, drafted at close, with the inventory); eslint adoption (S49);
  issue #11 (ship the injector, a feature); D1, D2, D3 and ledger rows 22, 28 (Kun's); issue
  #75 (needs a public host); issue #12 (a trait owns its converge).

## Requirements

1.1 `appbay restart` SHALL stop through the same code `appbay down` uses and start through
    `deploy()`, so it observes what it started and installs routes; its private render
    writer SHALL be gone (ledger row 40).
1.2 EVERY journey that ran `cd /home/ubuntu` SHALL take the directory from `WORKDIR`,
    defaulting to the multipass home, and at least three SHALL run on the Lima guests
    (row 42).
1.3 NOTHING in core SHALL name `apps/web` as a caller; the retired `RunningAppsDiscoverer`
    SHALL be gone (row 12).
1.4 `compile()` SHALL be handed `appbayHome` and SHALL not derive it from `appsDir` (F13).
1.5 THE KeePass database path and key file SHALL be resolved in one function (S3 LOW).
1.6 `server start`'s health wait SHALL use `fetch`, not a spawned `curl`; `checkGpu` SHALL
    report `unknown` when `nvidia-smi` is absent (Q5, Q1 LOW).
1.7 THE CLI SHALL not spawn the container binary itself: `logs`, `exec`, `pull`, `dive`,
    `mcp`, `tunnel`, `models`, `ollama`, `update` and `up --tail` go through `runtime/`
    (F17). Host-tool spawns in `init-system`, `setup`, `fixfs`, `size`, `stats` stay.
1.8 THE `docker.ts` wrapper comment SHALL say why the wrappers exist (the CLI's home
    resolver also reads the CLI-side system config), or the wrappers SHALL go (S10 LOW).
1.9 EVERY exported type knip lists as unused SHALL lose its `export` or its reader SHALL be
    named.
1.10 EACH review round SHALL read function bodies, cite lines, and record its findings with
    dispositions in this spec's log; a finding fixed in a round SHALL carry the commit.

## Decisions & Corrections

**2026-09-06** — Kun: "fix up and run full internal code reviews iteratively until
everything is finally green", and "you already have multiple reviews in history, look at
them too". Autonomous for the rest of the sprint; no per-row confirmation.

**2026-09-06** — `cliContainerBin` was first kept on the claim that the CLI's home resolver
consults a file core's does not. Round 2 read both: `utils/system-config.ts` reads
`/etc/appbay/config` through core's own `readHostPointer`, and the user pointer is the same
path. The two resolvers cannot disagree; the wrappers were indirection without a difference
and are gone. The earlier decision here was wrong and is recorded as such.

**2026-09-06** — Reviews are run by fresh subagents (at most three at once), one per
region, each handed the S1–S13 / Q1–Q7 rubric and told to read bodies; every finding is
verified in the main session against the file before it is fixed or dismissed.

# 2 · Design

## Restart

`down.ts` gains `stopApps(appbayHome, names)`: discover, order in reverse of `deployOrder`,
`compose down` each, return `{found, stopped, failed, unknown}`. `restart` calls it, then `deploy()` with
the same targets and prints through `printDeployReport`. Two commands, one stop path, one
start path.

## CLI spawns

`runtime/container-runtime.ts` already has `containerExec(args, options)` whose options are
`SpawnSyncOptions`, so `stdio: "inherit"` passes through. It gains `containerSpawn(args,
options)` for the two long-running cases (`logs -f`, the tunnel). The CLI sites replace
`spawnSync(cliContainerBin(), …)` with `containerExec(…, { appbayHome, stdio: "inherit" })`.
The arch rule "only runtime/ spawns a process" extends its scope to `apps/cli/src` with the
host-tool files listed as exempt.

## Review rounds

```
round n:
  three reviewers, regions: (A) services/deploy, deploy-service, observe, boot-order
                            (B) apps/cli commands that reach deploy or the runtime
                            (C) the diff of S47 + S48 so far
  each returns findings in the 03-CODE_QUALITY format
  main session verifies each against the file, fixes or dismisses with a reason, commits
  round n+1 until a round returns nothing above LOW
```

# 3 · Tasks

- [x] 1.1 `down.ts` `stopApps`; `restart.ts` through it and `deploy()` (row 40)
- [x] 1.2 journeys `WORKDIR` (row 42); apply-success and lifecycle on both guests run under 3.1
- [x] 1.3 row 12 residue
- [x] 1.4 `CompileOptions.appbayHome` (F13)
- [x] 1.5 KeePass env once
- [x] 1.6 `fetch` health wait; `checkGpu` unknown
- [x] 1.7 CLI container spawns through `runtime/`; arch rule scope widened
- [x] 1.8 `docker.ts` comment
- [x] 1.9 knip's unused exported types
- [x] 2.1 review round 1, fixes
- [x] 2.2 review round 2, fixes (round 3 pending)
- [ ] 3.1 journeys on both guests; ledger; pillars current state; S49 drafted; close

## Log

**2026-09-06** — created. Baseline after S47: core 1126, CLI 385, tsc clean, `check:*`
green, knip: 12 unused exported types and one unused docs file.

**2026-09-06** — 1.1–1.9 landed in 127fc05. Also found while converting setup.ts: its
Traefik scaffold writes three files through `bash -c "cat > <path> << 'EOF' …"` with the
path interpolated (ledger row 43); held for the round-1 reviewer of that region and fixed
after.

**2026-09-06 — round 1.** Three reviewers (core deploy path; CLI commands; the S47+S48
diff). Every finding was read against the file before it was acted on.

| # | lens | where | finding | disposition |
|---|---|---|---|---|
| R1.1 | Q1/S1 HIGH | `boot-order.ts:142` | `appbay up web` refused when `after:` names a project only an app outside the target set declares | fixed: `deployOrder` takes the installed apps' projects; `deploy()` and `stopApps` pass them; test |
| R1.2 | S1/Q1 HIGH | `converges.ts` project link, `report.ts` | a readiness timeout left a running, unrouted container reported as a plain failure (the #5 shape, reintroduced by the reorder) | fixed: reason `not-ready`, the fold marks it a partial converge; tests |
| R1.3 | REGRESSION HIGH | `converges.ts` upstream edges | a dependency whose route failed no longer blocked its dependents (F2 reversed silently) | fixed: the upstream edge is the dependency's project and route; test |
| R1.4 | Q1 HIGH | `install.ts:135,145,151` | `install --as` validated and named the catalog name, not the installed one | fixed |
| R1.5 | Q5 HIGH | `install.ts`, `up.ts`, `setup.ts` | three ways to re-invoke `appbay`, one of them a bare PATH lookup whose ENOENT was swallowed | fixed: `utils/self.ts`, the error printed |
| R1.6 | Q1 HIGH | `size.ts:16-27` | the VOLUMES column could never populate on Docker (rejected template, wrong name match) | fixed: one `/system/df` read over the socket, summed by compose project label |
| R1.7 | Q3 HIGH | `setup.ts:124,143,196` | three files written through `bash -c "cat > <path> << EOF"` with the path interpolated | fixed: `node:fs`; `run()` (no callers) deleted (ledger 43) |
| R1.8 | S1 HIGH | `tunnel.ts:18-20` | the tunnel target was `localhost:<port>` from inside the cloudflared container | fixed: `http://<service>:<port>` |
| R1.9 | Q1/S7 MED | `converges.ts` readiness probe | an unobservable probe was folded into a timeout | fixed: `unobservable(reason)`; test |
| R1.10 | Q5 MED | `converge.ts:64` | a throwing link discarded every verdict and the report | fixed: caught into `diverged`; test |
| R1.11 | S5/Q6 MED | `converges.ts`, `route.ts` | on traefik the route file was written at render, before the upstream existed | fixed: route files (both providers) are written by the route link after the edge is seen; test |
| R1.12 | Q1 MED | `stats.ts`, `pull.ts`, `update.ts` | exit codes dropped; a dead `renderPath \|\| composePath`; `--version` after replace unchecked; `--system-only` a second image list | fixed: exit codes; `existsSync` fallback; the new binary must run; system images pulled through the install's own renders |
| R1.13 | S5 MED | `models.ts:31-45` | `docker port` text and a Go template parsed in a command file | fixed: `containerEndpoint` in `runtime/observe.ts` over the API |
| R1.14 | shape 3 MED | `arch.test.ts` | the spawn rule exempted the files most likely to regress | fixed: a second rule with no exemptions; it found `resolve-for-deploy`, `route.ts`, `edge-identity-service`, `run-shepherd` still spawning the binary; all four now go through `runtime/` |
| R1.15 | S3/S7 MED | `setup.ts` | Docker named where the runtime may be Podman; `info` without timeout; child output grepped for "already"/"No apps found" | fixed: the profile's name; 10 s timeouts; exit codes only, and the edge observed by label after its deploy |
| R1.16 | LOW | several | shepherd `share` fallback to a name that never existed; `shepherdErrors` flattened; `plan.status` cast hid `removed`; caddy exec without timeout; a half-written candidate on EACCES; stale comments and dead code in `up`, `docker.ts`, `appbay-home.ts`, `server.ts`, `container-runtime.ts`, `compile.ts`; `down` lost "No apps found to stop." | fixed |
| R1.17 | LOW | `route.ts` | Caddy's stdout is returned verbatim into `error`; may echo a directive | accepted: the adapter names the line and directive, not values; `edge.ts` already filters its own copy |
| R1.18 | GAP LOW | spec 1.6 | "the compose file is rewritten on an unchanged plan" has no test | dismissed: an unchanged plan means the bytes on disk already equal the render, so the rewrite is a no-op by definition; the `.env` copy is the observable part and is tested |
| R1.19 | DRIFT LOW | `s28-journey-rootful-podman.sh:95` | `WORKDIR` substituted into a rootless user's home inside a heredoc the variable never reaches | reverted to the literal with a comment |
| R1.20 | INFO | `deploy-report.ts` | `shepherdErrors` had no reader | fixed: printed under the app |

Not taken from round 1: `builds.ts` still spawns the container binary through a local `bin`
(six sites in the build path, listed in the first arch rule; no journey here exercises the
build) — carried to S49 as a task beside the config loader.

**2026-09-06 — round 2.** Three fresh reviewers over the same regions plus the round-1 diff.
Round 1's fixes had introduced four defects; every finding was read against the file.

| # | lens | where | finding | disposition |
|---|---|---|---|---|
| R2.1 | Q1 HIGH | `edge-identity-service.ts:56` | `!claimIdentityStoreOwnership()` negated a Promise (always false): on EACCES the retry raced the un-awaited chown | fixed: awaited |
| R2.2 | S1 HIGH | `update.ts` | round 1's `compose pull` over every system render failed on the Caddy edge, whose service has `build:` (confirmed on Docker 29: 404 from the registry) | fixed: only services without `build:` are pulled |
| R2.3 | S1 HIGH | `size.ts` | round 1's volume sum keyed on a label Podman's compat `/system/df` does not return: `0 B` for every app on the S45 host | fixed: name prefix as the fallback (`<project>_…`, `appbay-secrets-<app>`); `?type=volume`; negative sizes skipped |
| R2.4 | Q1/S1 HIGH | `apply.ts:42-51` | compile errors never printed; a manifest that did not compile read as "All apps are up to date", exit 0 | fixed: printed as `up` prints them, exit 1 |
| R2.5 | REGRESSION HIGH | `tunnel.ts` | round 1's `t.service` condition returned null for manifests that omit `service` (two in the catalog), and a bare service name is ambiguous on the shared network | fixed: the upstream is the service's alias on `appbay_shared`, read from the render |
| R2.6 | Q1/S1 MED | `converges.ts` project link | round 1's `not-ready` labelled a container that died during the wait "started but unreachable" | fixed: the deadline re-runs the crash check; test |
| R2.7 | S7/Q1 MED | `container-runtime.ts`, `route.ts` | a Caddy exec that hit the new 60 s timeout was reported as "the edge is not running"; the compensating reload was skipped | fixed: `timedOut` told apart from `failedToStart`; a `timeout` reason with its own message; reload attempted |
| R2.8 | S3 MED | `edge-identity-service.ts` | the round-1 timeout landed at one of four edge exec sites | fixed: all four |
| R2.9 | shape 3 MED | `arch.test.ts` | the no-exemption rule did not match `const bin = containerBin(); spawnSync(bin, …)`, `tryExec(containerBin(…))`, nor `const { spawnSync: ss } = require(…)` in the secrets trait | fixed: the rule matches a local `bin`/`binary` and any call whose first argument is the binary; it found `checks.ts` (two), `info.ts` (a host-tool helper, renamed), the secrets trait's `image inspect`; all through `runtime/`; `builds.ts` listed with its S49 task |
| R2.10 | Q4/Q5 MED | `engine-api.ts` | the 5 s socket idle timeout on `/system/df` | fixed: per-call timeout, 60 s there |
| R2.11 | S3/Q7 MED | `docker.ts` | the wrapper justification was false (see Decisions) | fixed: both wrappers deleted, callers use core with the CLI home |
| R2.12 | Q1 MED | `self.ts` | a PATH lookup can only pick a binary other than the running one (a bun executable reports itself as `process.execPath`) | fixed: `process.execPath` |
| R2.13 | Q5 MED | exec, dive, mcp, ollama, stats, pull, up | a container binary that never ran exited 1 with no text under `stdio: "inherit"` | fixed: `exitWithContainerResult` prints the spawn error |
| R2.14 | Q5/Q1 MED | `setup.ts --reset` | `compose down` results dropped, then the renders deleted; a failed stop orphaned a running edge | fixed: through `stopApps`, aborting the delete on failure; the alpine `rm` checked |
| R2.15 | S3 MED | `setup.ts` | "Docker Engine" / "Docker network" where the runtime may be Podman; `context inspect` without timeout; the Traefik health wait spawned `curl` and `sleep` | fixed: the profile's name; timeout; `fetch` |
| R2.16 | Q1 MED | `update.ts replaceBinary` | a rename from `/tmp` fails with EXDEV on a separate filesystem and reached for `sudo` | fixed: copy into the target directory, then rename; `sudo` only on EACCES/EPERM |
| R2.17 | LOW | several | `edge.ts` `startStack` ignored compile errors; `server.ts` "within 30s" understated; stale headers in `docker.ts` and its test; `observe.ts` dynamic import; `resolve-for-deploy` comments and an unchecked `volume create`; a redundant cast; `in` on a plain object; the shepherd share lookup accepting a stopped container; the traefik path not restoring a half-written candidate; `install` conflating "could not run" with "failed"; a journey's `secrets set` without `APPBAY_HOME`; two doc lines describing the render as the writer of edge fragments; the spec's `stopApps` shape | fixed |
| R2.18 | Q6 LOW | `converges.ts` | `shepherd:post` depends on `route`, so a post-deploy hook is skipped when the edge is down | left for Kun: a design question, recorded here |
| R2.19 | INFO | new code paths without a test | `containerEndpoint`, `apiDiskUsage`, `containerSpawnSync`, `write-failed`, the `removed` refusal, `stopApps.found`, setup's post-deploy edge check, update's pull loop | recorded as untested; the two runtime readers were verified by hand on Docker 29 and Podman 5.8 by the reviewer |
