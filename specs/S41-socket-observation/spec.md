---
spec_id: S41-socket-observation
status: ACTIVE
closed_as: null
since: 2026-09-05
until: null
epic: platform
features: [engine-api-client, observer-seam, socket-resolver-in-core]
supersedes: []
superseded_by: null
depends_on: [S40-namespace-values]
anchors: [data-architecture]
---

# S41: observe by socket, mutate by compose

# 1 · Requirements

## Introduction

Kun's rule, and stackbay's L10: the core does not parse container-CLI text to learn state.
Docker Compose and podman-compose disagree on flags, field names and banners; every parser of
theirs existed twice and one of them was vacuous on Podman for weeks. The runtime's API over its
unix socket — Docker's Engine API, which Podman serves as its compat API — has one typed shape.
Mutation stays with the compose binary, which owns project naming and recreate semantics.

## Mental Model & Invariants

- `runtime/socket.ts` resolves the socket once; `runtime/engine-api.ts` speaks HTTP to it;
  `runtime/observe.ts` answers every question about containers and networks from it through an
  `Observer` that a test can replace with rows.
- No fallback to text parsing: a host without a reachable socket answers `unknown` naming the
  path and how to enable the socket.
- `DockerComposeRunner` remains the mutation seam (`up -d`, `down`, `build`, `run`).

## Requirements

1.1 THE socket resolver SHALL live in core and honour `APPBAY_RUNTIME_SOCKET`, docker's
    `unix://` `DOCKER_HOST`, podman's `unix://` `CONTAINER_HOST`, then the runtime's default.
1.2 THE Engine API client SHALL provide ping, list (by label and name), inspect, network
    exists, image id, each as an `Inspection`, with a 5 s timeout and typed answers.
2.1 `findContainerByLabel`, `isRunning`, `networkExists`, `runningContainerNames`, the compose
    project rows, `findCrashedServices`, `snapshotContainers`, `isReady` SHALL read the API.
2.2 `deploy()` SHALL take an `Observer`; tests SHALL feed rows, not CLI text.
3.1 `appbay ps`, `server status`, doctor's network and server checks, setup's status, `stats`,
    `tunnel-down`, the build evictor and the ollama probe SHALL observe through the same seam.
4.1 The observation tests SHALL run against a real HTTP server on a real unix socket answering
    the Engine API's shapes.

## Out of Scope
- `inspectEdgePorts` (edge migration) and the build evictor's image-id compare still read the
  CLI; they are the two remaining entries in the arch test's template list with their reasons.
- `info`/`version` probes (store root, versions) stay on the CLI: they are about the runtime,
  not about containers.
- Podman verification (issue #9).

# 2 · Design

`Observer { project(app), findByLabel(label, value, labels?), networkExists(name) }`;
`engineObserver(home, socket?)` is the implementation. Rows carry service (from the compose
service label), state, status, health (parsed from the status line), ports, and the exit code
(inspected only for exited containers). The compose project is the app directory's name, which
compose derives from the render's directory (measured in the review).

# 3 · Tasks

- [x] 1.1 `runtime/socket.ts`; `server.ts` and `dive.ts` use it
- [x] 1.2 `runtime/engine-api.ts`
- [x] 2.1, 2.2 `runtime/observe.ts` on the API with the `Observer` seam; `deploy()`, route install and the caddy exec take it
- [x] 3.1 CLI and core callers converted; `checkNetwork`, `checkServer`, `checkSharedNetworkDns` async
- [x] 4.1 `engine-observer.test.ts` over a unix-socket server; converge, readiness and route tests feed rows
- [ ] 5.1 live: init, up, ps, doctor on the local Docker through the socket

## Log
