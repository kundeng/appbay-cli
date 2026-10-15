---
spec_id: S50-remote-endpoint
status: ACTIVE
closed_as: null
since: 2026-10-14
until: null
epic: runtime
features: [runtime-endpoint, endpoint-bridge, path-identity-check, remote-bind-lint]
supersedes: []
superseded_by: null
depends_on: [S48-review-green]
anchors: [data-architecture]
---

# S50: a system is the endpoint it deploys to, wherever appbay runs

# 1 · Requirements

Issue #15 asks for the use case this sprint opens: the same upstream Compose project, unchanged, run on a laptop and on a server, with appbay operating the server from the laptop. The owner decided the boundary on 2026-10-14 (option B of the system-boundary decision): **a system is the target runtime endpoint, operated from this machine or another.** appbay owns the app model and that one endpoint; it consumes path identity, name resolution and routing from its environment, and builds none of them. A shared export mounted at the same absolute path is one provider of path identity today; a projection layer on the laptop (the remotebay design) is a later one; neither is in this repository.

Today the two halves of a deploy can reach two daemons. `packages/core/src/runtime/socket.ts:30-39` observes over a local socket only (`APPBAY_RUNTIME_SOCKET`, a `unix://` `DOCKER_HOST`, else the default), while the compose child inherits `process.env` (`container-runtime.ts:405`) and follows `DOCKER_CONTEXT` or an `ssh://` host. Issue #16 shows `doctor` and `up` reporting failures for work that succeeded on the remote daemon; the same split can report a failed remote deploy as success.

## Mental model

- **The endpoint** is the one daemon a system deploys to and observes. appbay resolves it once per command, in the Docker CLI's own order, and hands the same answer to both halves.
- **Two halves, one answer.** Mutation goes through the container binary; observation goes through the Engine API (`docs/steering/structure.md`). Both receive the resolved endpoint explicitly; neither re-resolves from the environment on its own.
- **Transport is consumed, not owned.** For `ssh://`, appbay uses the same mechanism the Docker CLI uses, `ssh <host> docker system dial-stdio`, for the life of the command. It does not hold tunnels, publish names, or sync files.
- **Path identity is checked, not provided.** Rendered compose files bind host paths under `APPBAY_HOME`. Those paths must name the same files on the endpoint's host. appbay verifies that and refuses when it does not hold; making it hold is the environment's job.
- **Promise 3 still governs.** An endpoint appbay cannot reach or verify makes a check `unknown`, never ok and never failed.

## Verified before writing (2026-10-14)

- Docker CLI 29 on macOS ranks `DOCKER_HOST` above `DOCKER_CONTEXT`, then the current context: with both set to different daemons, `docker info` answered from the `DOCKER_HOST` one. `docker context inspect <name> --format '{{.Endpoints.docker.Host}}'` returns the context's host.
- Bun 1.3.14's `node:http` ignores `createConnection`, so an HTTP request cannot ride a child's stdio directly (`ECONNREFUSED`; the same script works under Node 24). A local unix socket whose every connection is piped to `ssh <host> docker system dial-stdio` works under Bun: two parallel Engine API calls returned 200 in 381 ms, with the existing `request({ socketPath })` client unchanged.
- The Docker 29 daemon rejects API version `v1.43` paths with 400; unversioned paths succeed. The client already uses unversioned paths.

## Requirements

1.1 THE runtime module SHALL resolve one **endpoint** per command, in this order: `APPBAY_RUNTIME_SOCKET`; `DOCKER_HOST`; `DOCKER_CONTEXT`; `endpoint` in `etc/system.yaml`; the Docker CLI's current context; the runtime's default socket. The result is a discriminated value: `unix` (a path), `ssh` (a destination), `tcp` (host and port), or `unsupported` (the raw value and why).
1.2 EVERY spawn of the container binary SHALL receive the resolved endpoint as `DOCKER_HOST` in its environment (and no `DOCKER_CONTEXT`), so compose cannot pick a different daemon than observation.
1.3 Observation over an `ssh` endpoint SHALL use an in-process bridge: a unix socket under a short path, each connection piped to `ssh <dest> docker system dial-stdio`, closed with the command. A `tcp` endpoint without TLS SHALL be observed directly; `tcp` with TLS, and `unsupported`, SHALL yield `unknown` with the reason.
1.4 `appbay init --endpoint <value>` SHALL record the endpoint in `etc/system.yaml`; `appbay info` and `doctor` SHALL print the resolved endpoint and which source chose it.
1.5 Before deploying to an endpoint that is not the runtime's default local socket, `up` and `apply` SHALL verify path identity: write a nonce file under `APPBAY_HOME`, run the existing helper image with `APPBAY_HOME` bind-mounted read-only, and compare. A mismatch or an empty mount SHALL refuse the deploy with the paths named; a check that cannot run SHALL report `unknown` and refuse. `doctor` SHALL run the same check for every endpoint.
1.6 WHEN the endpoint is not the default local socket, `compile`/`up` SHALL warn for each service that bind-mounts a host **directory** without `:ro`, naming the service and the path and suggesting a named volume. A warning, never a failure.
1.7 Podman keeps its current behaviour: `CONTAINER_HOST` with `unix://` as today; any other Podman remote is `unsupported` and `unknown`, stated in the guide.
1.8 `docs/steering/product.md` SHALL replace "System is physical: this box, this installation" with the decided definition, and a guide SHALL describe operating a system from another machine with a shared export as the path provider.
1.9 Each new behaviour SHALL carry a test that fails before it; the existing suites SHALL pass at every commit; one journey SHALL run end to end from a macOS client to a Linux daemon over `ssh://`.

## Configuration

- `endpoint` in `etc/system.yaml` | plane: deploy-time | owner: `packages/core/src/runtime` | values: `unix:///path`, `ssh://user@host[:port]`, `tcp://host:port`; absent means "follow the environment".
- No secret is added. SSH authentication is the user's SSH configuration and agent.

## Out of scope

- Any file sync, tunnel that outlives a command, DNS record, or certificate distribution (providers, per the decision).
- More than one endpoint per system; multi-host scheduling.
- #17, #18 and #19 (separate defects; a hardening sprint adopts them).
- Folding the environment reads into S51's single loader (renumbered from S49). S51 lists `DOCKER_HOST` and the socket variables for its schema; this sprint keeps them in `runtime/` behind one function so S51 can absorb them without a second resolver.

# 2 · Design

## End-to-end walkthrough

On a laptop, `DOCKER_CONTEXT=lab appbay up whoami`, home on an export the server mounts at the same path:

1. `resolveEndpoint()` reads the context's host, `ssh://user@server`, source `DOCKER_CONTEXT`.
2. `up` sees a non-default endpoint and runs the path check: nonce written under the home, helper container on the server mounts the home read-only and reads it back; equal, so the deploy proceeds.
3. Compile renders as today; the remote-bind lint warns for writable directory binds.
4. The compose child runs with `DOCKER_HOST=ssh://user@server` and no `DOCKER_CONTEXT`.
5. The converge chain observes through the bridge socket, which reaches the same daemon, and the verdicts reflect what ran there.
6. The command ends; the bridge closes and removes its socket.

## Components and boundaries

| Unit | Owns | Used by |
| --- | --- | --- |
| `runtime/endpoint.ts` (new) | `resolveEndpoint()`: order, sources, the `Endpoint` union; `endpointEnv()` for spawns | `socket.ts`, `container-runtime.ts`, `info`, `doctor`, `init` |
| `runtime/bridge.ts` (new) | `openBridge(endpoint)`: unix socket for `ssh`, pass-through for `unix`, `unknown` otherwise; closes on command exit | `socket.ts` / `engine-api.ts` |
| `runtime/socket.ts` | becomes "the socket for this endpoint": delegates to endpoint and bridge | engine API, server command |
| `runtime/container-runtime.ts` | every spawn helper merges `endpointEnv()` into the child environment | all spawn sites (already funnelled here) |
| `services/path-identity.ts` (new) | the nonce check, returning an `Inspection` | `up`, `apply`, `doctor` |
| compiler lint (in the existing validation pass) | the remote-bind warning | `compile`, `up` |
| `schemas/instance.ts` | optional `endpoint` field | `init`, endpoint resolver |

## Failure and recovery

- `ssh` not on `PATH`, or authentication fails: the bridge's first connection fails; every observation is `unknown` with ssh's stderr; `up` refuses before mutating because the path check is `unknown`.
- The bridge socket path must stay under the 104-byte macOS limit: it lives under `os.tmpdir()` with a short name, and is removed on exit, including on signals.
- A stale `DOCKER_CONTEXT` naming a missing context: `unsupported` with the CLI's error.

## Verification

- Unit: resolution order with each source set and combinations (1.1); spawn environment carries `DOCKER_HOST` and drops `DOCKER_CONTEXT` (1.2); path-check outcomes (equal, different, empty mount, helper failed) (1.5); lint cases (`:ro` directory, file bind, named volume, writable directory) (1.6).
- Integration: the bridge against a local daemon reached as `ssh://localhost` in CI where available, otherwise documented as a journey (1.3).
- Journey: macOS client, Linux daemon over `ssh://`, home on a shared export at the same path: `init --endpoint`, `doctor` all required checks pass, `up traefik whoami` reports both deployed, `appbay ps` lists them, and a deliberately mismatched home is refused by the path check (1.9).

# 3 · Tasks

- [x] 1. Foundation
  - [x] 1.1 `runtime/endpoint.ts`: `Endpoint` union, `resolveEndpoint()` with sources, `endpointEnv()`; unit tests for order and parsing. Requirements: 1.1, 1.7.
  - [x] 1.2 `endpoint` in `InstanceConfigSchema`; `init --endpoint` writes it. Requirements: 1.4.
- [ ] 2. Core
  - [x] 2.1 Spawn helpers in `container-runtime.ts` merge `endpointEnv()`; grep proves no spawn bypasses them. Requirements: 1.2.
  - [ ] 2.2 `runtime/bridge.ts` and `socket.ts` delegation; `engine-api.ts` unchanged apart from where the socket comes from. Requirements: 1.3.
  - [ ] 2.3 `services/path-identity.ts`; wired into `up`, `apply`, `doctor`. Requirements: 1.5.
  - [ ] 2.4 Remote-bind lint. Requirements: 1.6.
  - [ ] 2.5 `info` and `doctor` print the endpoint and its source. Requirements: 1.4.
- [ ] 3. Tests
  - [ ] 3.1 Journey from macOS to a Linux daemon over `ssh://`, recorded in `docs/history/`. Requirements: 1.9.
- [ ] 4. Docs
  - [ ] 4.1 Steering definition of **System** (product.md) per the decision. Requirements: 1.8.
  - [ ] 4.2 Guide: operate a system from another machine; providers of path identity; Podman limits. Requirements: 1.7, 1.8.
  - [ ] 4.3 Close #16 and update #15 with what shipped. Requirements: 1.9.

## Log

- 2026-10-14: drafted from #15/#16 and the owner's decision (option B). Resolution order, the Bun `createConnection` gap and the bridge were measured before writing (section "Verified before writing").
- 2026-10-14: 1.1 done. `resolveEndpointFrom` is pure (environment, configured value and a context reader passed in); 22 unit tests cover each precedence step, Podman's rule, URL forms and `endpointEnv`. Live on macOS: the current context resolved to OrbStack's socket, `DOCKER_CONTEXT=homecloud-work` to its `ssh://` host, a missing context to the CLI's own error. `endpoint.ts` imports `runtimeSocketFor` from `socket.ts`; task 2.2 moves that function here so `socket.ts` can depend on `endpoint.ts` without a cycle.
- 2026-10-14: 1.2 done. `endpoint` in `InstanceConfigSchema` (scheme-checked; a bad value drops the file to defaults like every other key); `resolveEndpoint(home)` in `container-runtime.ts`, cached per home and cleared with the runtime cache; `appbay init --endpoint` validated by `parseHost`, written on a fresh install and upserted on an existing one (`upsertEndpoint`). `runtimeSocketFor` moved into `endpoint.ts` so `endpoint.ts` imports nothing else from `runtime/`. Full suite: core 1170 passed / 7 skipped, CLI 411, DB 27.
- 2026-10-14: 2.1 done. `childEnv()` in `container-runtime.ts` applies the endpoint to `containerExec`, `containerSpawnSync` and `containerSpawn`. `compiler/builds.ts`'s six direct spawns now go through `containerSpawnSync` with the deploy's own home (taking S51 task 1.5 forward, and ending the default-home resolution ledger row R4.10 named there); both arch allow-lists for `builds.ts` are now empty. Inside `runtime/` the remaining direct spawns are `tryExec(bin, --version)`-style version probes, which contact no daemon, and `endpoint.ts`'s own `docker context` reads, which must run without `DOCKER_HOST`. A stand-in `docker` on `PATH` proves each helper's child sees the context's host as `DOCKER_HOST` and no `DOCKER_CONTEXT` (`child-env.test.ts`). Full suite: core 1175 / 7 skipped, CLI 411, DB 27.
