---
spec: SPEC-002
title: One deploy path for the CLI and the web
closes: F5
status: proposed
priority: 2 — highest value, medium risk
---

# SPEC-002 — One deploy path for the CLI and the web

## Requirement

There must be exactly one implementation of "apply a compiled app". Every caller — `appbay
up`, the web UI's Up button, the job queue, any future API — goes through it. A deploy that
does not install the app's `auxiliaryFiles` is not a deploy and must not be reachable.

Success condition: an app with `ingress` and `auth` traits, deployed from the web UI, is
reachable at its host with its authorization policy in force — the same outcome as
`appbay up`.

## Why

The compiler's whole output is `rendered` **plus** `auxiliaryFiles`. Today the web writes
the first and drops the second, so the GUI — the surface a newcomer reaches first — silently
discards exactly the deployment concerns the product exists to compile in
([F5](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f5)). The plan
preview even lists the route files (`routers/plans.ts:112`) before the apply declines to
write them, so the UI actively misrepresents what it will do.

## Design, on existing seams

The seam already exists and is already correct: `@appbay/core`'s
`services/deploy-service.ts` → `services/deploy/converges.ts` → `services/deploy/route.ts`.
`route.ts` is the only module that may write a route or policy; it snapshots the previous
content, writes candidates, validates the complete imported Caddyfile, reloads without a
restart, and restores on failure. None of that is reproducible in a 199-line worker, and it
should not be attempted.

1. **Delete the second implementations.** `apps/web/src/server/queue/workers/deploy.ts` and
   the inline `dockerCompose` spawn in `routers/deployments.ts:38`. Both compile and apply
   independently of core.
2. **Point `deployments.up` at `deployPipeline`.** `fullDeploy` already does this correctly
   and its docstring already claims parity with `appbay up`; it simply has zero UI call
   sites. The cheapest correct change is to make `up` an alias for `fullDeploy`'s body and
   retire the duplicate name, rather than rewiring four UI components to a differently
   named procedure.
3. **Make the queue worker a queue worker.** `workers/deploy.ts` keeps job lifecycle,
   `EventBus` streaming and secret redaction, and delegates the actual apply to
   `deployPipeline`, passing its line callback through `DeployOptions`.
4. **Route runtime selection through `containerBin(appbayHome)`.** The web server hardcodes
   `"docker"` at 16 spawn sites; the CLI has one resolver. Every one of those sites is a
   podman install broken in the UI.
5. **Re-establish a shared API.** The web calls `compile({activeApps})`, an option the
   current core deliberately removed
   (`compiler/compile.ts:74-78`). Deciding this is the prerequisite for everything above:
   either `appbay-mac`'s web app moves into `appbay-cli-mac`, or it pins a published
   `@appbay/core` version and upgrades. Two cores with the same name and different APIs is
   the condition that produced this defect and will reproduce it.

## What it must not break

- **`appbay up` semantics.** Boot order, project grouping, readiness waits, crash grace,
  and the per-app refusal gate at `deploy-service.ts:154-164` are the CLI's tested
  behaviour and become the web's behaviour unchanged.
- **Streaming.** The UI's `deploy.logs`/`deploy.status` events must keep flowing;
  `deployPipeline` must expose a line callback rather than the worker reading a pipe.
- **Secret redaction.** `workers/deploy.ts` redacts `=<value>` patterns before emitting.
  Whatever survives must keep doing so — losing it while consolidating would turn a
  correctness fix into a disclosure.
- **The refusal path must reach the UI.** `appbay up`'s refusal message is the only thing
  standing between an operator and an unauthenticated deployment ([F15](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f15));
  it must surface as a visible failure, not a silent no-op.
- **Edge validation is not optional.** `route.ts` validates the imported Caddyfile before
  reloading. A web path that skipped it could take the edge down for every app at once.

## How to verify

1. **The plan/apply invariant, as a test.** For any compiled app, every path in
   `plans.get`'s `auxiliaryFiles` list exists on disk after a successful deploy through
   *any* caller. This is the assertion whose absence allowed the defect.
2. **A grep-level guard in CI.** `auxiliaryFiles` must not be referenced outside
   `@appbay/core` except for display; `spawn("docker"` must not appear outside
   `container-runtime.ts`. Both are cheap and both would have caught this.
3. **End-to-end, both callers.** Deploy one app with `ingress` + `auth` via `appbay up` and
   via the UI; diff `etc/apps/caddy/config/` after each. The trees must be identical.
4. **Podman.** Run the UI against `container_runtime: podman` and confirm a deploy
   succeeds — impossible today.
