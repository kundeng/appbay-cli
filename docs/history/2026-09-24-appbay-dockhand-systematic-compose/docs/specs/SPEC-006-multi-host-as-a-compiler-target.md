---
spec: SPEC-006
title: Multi-host, as a compiler target rather than a remote-control layer
closes: part of F8
status: proposed — staged; stage 0 is a decision, not code
priority: 6 — high value, highest risk; do not start before SPEC-001..004
---

# SPEC-006 — Multi-host, as a compiler target rather than a remote-control layer

## Requirement

One `APPBAY_HOME` can compile and deploy its apps across more than one host, with each
app's declared deployment concerns — ingress, TLS, auth, env, secrets — in force on the
host that runs it.

## Why this is the one structural gap worth taking seriously

Every other Dockhand lead is a feature AppBay could add or decline on its merits. This one
is the only place where Dockhand's architecture does something AppBay's shape forbids, and
`traits/types.ts:5-6` says so in words: *"adapted for single-node Docker Compose."*

## The mechanism that actually blocks it

Copying Dockhand's approach — thread a host id through every call — is the wrong lesson,
and it is worth being precise about why. Dockhand can parameterise by `envId` (2,822
references) because its transport is the Docker **HTTP API**: `dockerFetch(path, opts,
envId)` reaches any daemon that will answer. AppBay's transport is a local **process
spawn**, and that is the smaller half of the problem.

The real blocker is delivery. AppBay's compiler does not only produce a compose file; it
produces `auxiliaryFiles`, and `services/deploy/route.ts:35,45` installs them with
`join(appbayHome, aux.path)` — a **local filesystem write** that the edge container reads
through a bind mount. Caddy validation is then a `containerExec` into a **local** container.
So a second host needs the route file to arrive on that host's filesystem and that host's
edge to validate and reload it. Pointing `DOCKER_HOST` at a remote daemon moves the
containers and leaves the routes behind — which is exactly the failure Dockhand documents
for itself in `host-path.ts:620-628` (the daemon auto-creates an empty directory and the
deploy reports success).

CodeGraph bounds the transport half: 67 symbols in `containerBin`'s impact set.

## Design, on existing seams — staged

**Stage 0 — decide what "multi-host" means here, and write it down.** Two readings, and
they have different costs:
- *(a) One edge, many compute hosts.* The install keeps one Caddy/Traefik; apps run
  wherever; routes still point at one proxy which reaches upstreams over a network. Route
  delivery stays local. This is much the cheaper reading and fits the existing
  `appbay_shared` alias model, provided the shared network spans hosts.
- *(b) Many independent installs, one control plane.* Each host has its own edge and its
  own `APPBAY_HOME`; the compiler targets each. This is Dockhand's model and needs
  everything below.

**Recommendation: (a).** It is the reading that preserves the compiler's contract — one
route, one host, one policy — and it is reachable without a distributed filesystem.

**Stage 1 — name the host in the manifest, as a trait-shaped concern.** `appbay.yaml`
already carries `namespace` and `project`. Add a `host:` scope field, defaulting to
`local`. This is a scope decision, not a trait: it selects a target, and traits describe
what is true of an app wherever it runs.

**Stage 2 — give the spawn layer a target.** `containerExec`, `containerSpawn`,
`containerSpawnSync` and `containerCompose` take `appbayHome` today. Add an optional
`target` resolved from the same instance config that already resolves the runtime and the
ingress provider — `resolveContainerRuntime` and `resolveIngressProvider` are the shape to
copy, and the `RuntimeProfile` table is the precedent for absorbing a divergence in data
rather than in branches at call sites.

**Stage 3 — make route delivery explicit.** Introduce a `RouteSink` behind
`writeRouteFiles`, with a local-filesystem implementation that is exactly today's
behaviour. Under reading (a) that is the only implementation needed, and the seam is there
for reading (b) later. **Do not** make this an interface with one implementation and no
second caller — that is the `wrapper-live` and `on-stop` pattern this codebase has already
been bitten by twice ([F14](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f14)).
Add it when stage 4 needs it.

**Stage 4 — cross-host networking.** `appbay_shared` is a local bridge. Reading (a) needs
it to span hosts, which is an overlay network and therefore a Swarm or an external mesh —
a genuine dependency on something AppBay does not currently require, and the point at which
this becomes a product decision rather than a refactor. **Stop and decide here.**

## What it must not break

- **`traits/types.ts` must stop asserting single-node**, or the claim becomes stale
  documentation of the kind this investigation found elsewhere.
- **The ingress host-conflict check** (`compile.ts:335-390`) assumes one edge per install.
  Under reading (b) two hosts could legitimately claim one hostname; under (a) the check
  stays correct. Another reason to prefer (a).
- **`instance.ts:48-56` states that the ingress provider is installation-level because two
  apps disagreeing would emit valid config for a proxy that is not running.** Multi-host
  makes that reasoning sharper, not weaker — preserve it.
- **The local case must not pay for the distributed one.** A single-host install must issue
  the same commands it does today; `target: local` is the default and the fast path.
- **Secrets.** `resolve-for-deploy.ts` resolves secrets into the deploy environment
  locally. Reaching a remote host means secrets cross a network, which needs its own
  decision before stage 2 ships, not after.

## How to verify

- Stage 0's output is a written decision in `docs/rfc/`, not code.
- Stage 2: a single-host install's spawned argv is byte-identical before and after.
- Stage 3: `route.ts`'s existing tests pass unchanged against the local sink.
- Stage 4: an app declared on host B is reachable at its declared host through the install's
  edge, with its policy in force — the same end-to-end assertion SPEC-002 defines.
