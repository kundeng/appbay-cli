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
- [x] 2.2 review round 2, fixes
- [x] 2.3 review round 3, fixes
- [x] 2.4 review round 4, fixes
- [x] 2.5 review round 5, fixes (round 6 pending)
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

**2026-09-06 — round 3.** Three fresh reviewers. One HIGH and eight MEDIUM, five of them
consequences of round-2 fixes.

| # | lens | where | finding | disposition |
|---|---|---|---|---|
| R3.1 | Q1 HIGH | `edge-identity-service.ts:139` | after round 2's 30 s timeout, a failed or timed-out edge restart returned the same `false` as "not running", and the CLI printed the benign message | fixed: three answers (`restarted`, `not-running`, `{failed}`); `edge users` exits 1 naming the failure and the command to run |
| R3.2 | Q1/S1 MED | `deploy-service.ts`, `compile.ts:262` | an unknown target app was dropped silently: `appbay up typo` exited 0 with "No apps found" | fixed: named as a `target`-stage error in `deploy()`, one site for every caller; test |
| R3.3 | Q1/S7 MED | `health/checks.ts` DNS probe | a probe that never ran or timed out was reported as a failed lookup with "recreate the network" | fixed: `unknown` with the reason |
| R3.4 | Q1 MED | `route.ts` | the compensating reload's verdict was discarded and the timeout sentence claimed it succeeded | fixed: the reload's answer is part of the detail; the sentence no longer claims it; test |
| R3.5 | shape 3 MED | `arch.test.ts` | the no-exemption rule missed an aliased spawner (`spawnSync: ss`) and `Bun.spawn` | fixed: both forms matched; a `runtime` local too |
| R3.6 | S1 MED | `apply.ts` | `--yes` handed only changed-plan apps to `deploy()`, so a gone container behind an unchanged render read as "up to date" (the #4 shape) | fixed: every compiled target is converged; the plan is the preview |
| R3.7 | Q1 MED | `self.ts` | under `bun run` (dev) `process.execPath` is bun, so `setup` spawned `bun init` | fixed: `selfInvocation()` returns the pair `{bin, args}`; `update` refuses to self-update from bun |
| R3.8 | Q5 MED | `update.ts` | the running binary was replaced before the new one was verified; a bad asset bricked the host | fixed: the old binary is kept as `.appbay.old` until `--version` runs, restored on failure |
| R3.9 | S1 MED | `exec.ts` | `compose exec <app>` used the app name as the service name | fixed: the service is read from the render (the one on the shared network, else the only one) |
| R3.10 | REGRESSION MED | `setup.ts --reset` | `stopApps` skips an app whose render is gone, so the reset proceeded with the edge running | fixed: a running edge with no render aborts the reset; `stopApps` throws are caught |
| R3.11 | LOW | several | ENOBUFS labelled "never ran"; a compile error counted twice in the summary; a 2xx non-JSON engine body threw; two dead boot-order helpers and their ten tests; stale comments in `boot-order`, `run-shepherd`, `container-runtime` (the twin of the deleted wrapper claim); dynamic imports where static ones do; a stale exempt entry; the test header round 2 said it fixed; "Docker" in `info` and a `server` hint | fixed |
| R3.12 | LOW | `checks.ts:503,654` | `sudo -n <bin> …` spawns the binary through sudo; the rule matches neither | recorded: a host-tool spawn of the binary by design; S49 1.5 |
| R3.13 | LOW | `converges.ts` | `shepherd:post` depends on `route` (R2.18) | still Kun's |

Not pinned by a test after this round (recorded, not claimed): the edge restart's three answers, the DNS probe's unknown, the `update` restore path, `apply --yes` over unchanged plans, `exec`'s service choice, setup's reset abort, `selfInvocation` under bun. The rest of the round-3 fixes carry a test or the arch rule.

**2026-09-06 — round 4.** Three fresh reviewers. Two HIGH, six MEDIUM; two of the eight were
consequences of round-3 fixes, one was a latent hang in the engine client.

| # | lens | where | finding | disposition |
|---|---|---|---|---|
| R4.1 | Q5 HIGH | `engine-api.ts get()` | a daemon that closes the socket mid-reply left the request unsettled: the idle timeout never fires on a closed socket, so every observation the deploy makes could hang (reproduced on node 24 and bun 1.3.6) | fixed: the response's `close` before `end` rejects; a socket-server test cuts a reply off and expects `unknown` within a moment |
| R4.2 | S1/Q1 HIGH | `apply.ts` | round 3's `--yes` change handed `deploy()` an empty target list for a typo'd name, and an empty list meant "every app": `apply typo --yes` converged the install (reproduced) | fixed at both ends: `deploy()` treats `[]` as nothing; `apply` names an unknown target and exits 1; `apply` passes the user's names; scratch-home test |
| R4.3 | S1/Q1 MED | `pull.ts` | unknown names dropped, "1 pulled", exit 0 | fixed: named, exit 1; scratch-home test |
| R4.4 | S1 MED | `tunnel.ts --port` | `host.docker.internal` is not resolvable on Linux Docker without `--add-host`; the tunnel printed a URL that served nothing (confirmed on the Rocky guest) | fixed: `--add-host host.docker.internal:host-gateway`; the child's `error` event is heard; a failed pull fails the command |
| R4.5 | Q1/S7 MED | `checks.ts` DNS probe | round 3's fix left exit 125 (the container never ran: no image offline, no network) as a failed lookup with a destructive fix | fixed: only nslookup's own exit 1 is a verdict |
| R4.6 | S1 MED | `deploy-report.ts` | "the one printer" did not print `compileErrors`; `up` and `restart` each had a copy, `apply` had none, so a `projects.yaml` cycle under `apply --yes` failed silently | fixed: the printer prints them; the copies are gone |
| R4.7 | S7/Q1 MED | `deploy-report.ts` | every deployed row said "Started", including `convergeAction` unknown and already-running | fixed: the sentence follows the action |
| R4.8 | REGRESSION MED | `setup.ts` | round 3's exit 1 from `edge users reset-password` on a failed restart made setup discard the child's stdout, and with it the rotated bootstrap password | fixed: stdout is written before the status is judged |
| R4.9 | LOW | several | `edgeIsRunning` folded `unknown` into "not running" in the reset guard; `update`'s sudo branch could leave no binary and its restore could mask the original error; a duplicate doc block; thrown user errors surfaced as stacks (`parseAsync` with a handler); a refused app's row could show a skip instead of its refusal; a signal-killed child read "exited with code null"; `execFile` outside the arch rules; a dead `.catch`; stale test header and imports; stale "Docker" in two headers; an unused loop variable | fixed |
| R4.10 | LOW | `edge-identity-service.ts`, `run-shepherd.ts`, `resolve-for-deploy.ts`, `secrets.ts` | the binary is resolved from the default home at five sites the deploy could hand a home to | recorded: a single-home CLI cannot observe it; S49 1.5 with the config loader |
| R4.11 | LOW | `observe.ts:94` | an exited container that vanishes between list and inspect reads as a completed one-shot | recorded: the row is gone on the next read; no operator-visible verdict rests on one pass |

**2026-09-06 — round 5.** The diff reviewer returned nothing above LOW, the first region to
pass. The other two returned two HIGH and two MEDIUM, one of each a measured runtime fact.

| # | lens | where | finding | disposition |
|---|---|---|---|---|
| R5.1 | S1/Q1 HIGH | `observe.ts` | Podman's compat list API carries no health word in the status line (measured on the 5.8 guest), so every service read as healthcheck-less and the readiness gate never waited on Podman | fixed: a running container with no health word is inspected; a Podman-shaped fixture in the socket-server test |
| R5.2 | S1 HIGH | `update.ts`, `pull.ts` | round 2's pull filter read `build:` from the render, which the compiler strips; `update --system-only` still failed on every Caddy install, and `pull` had no filter | fixed: `utils/pullable.ts` decides from the manifest's `builds` and the upstream compose, used by both; unit test |
| R5.3 | S8/Q5 MED | `restart.ts` | `restart whoami typo` stopped whoami, then `deploy()` refused the run on the typo: the app stayed down (reproduced) | fixed: unknown names refused before anything stops; scratch-home test |
| R5.4 | LOW | several | `deploy-report` had no test (added, three cases); `DeployOptions.targetApps` did not say `[]` is nothing; two running edges read as "edge not running"; the sudo probe in doctor had no timeout; `apply` collects discovery errors for unrelated apps (recorded); an empty collection prints under "Compile errors" (cosmetic) | fixed, or recorded where marked |

Not pinned by a test after this round: the tunnel's `--add-host` and pull check, the DNS
probe's exit-125 branch, setup's stdout-before-status and `edgeState`, `update`'s restore
paths, `exec`'s service choice, the edge restart's three answers. Recorded, not claimed.
