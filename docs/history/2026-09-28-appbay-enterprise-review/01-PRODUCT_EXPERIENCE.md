# AppBay Product Experience Review

Date: 2026-09-28. This is a source review of `appbay-cli` at `af2c4b8` and sibling `appbay` at `4ae70c1`. It does not establish a successful deployment on a live host. Paths below use `cli:` for this repository and `ent:` for `../appbay/`.

| Area | Current experience | Status | Evidence |
|---|---|---|---|
| CLI app lifecycle | `appbay up` reaches core `deploy()`, which compiles, refuses apps with compile errors, orders convergence, and observes the runtime. | Implemented in source; S48 guest journeys pending | `cli:packages/core/src/services/deploy-service.ts:71-185`; `cli:specs/S48-review-green/spec.md:127-128` |
| Web app lifecycle | The Up controls use `deployments.up`; the planner uses `plans.compile` then `deployments.enqueue`; a separate `fullDeploy` route invokes the fork's core. | Fragmented | `ent:apps/web/src/components/apps/app-detail.tsx:62`; `ent:apps/web/src/components/deploy/deploy-planner.tsx:280-282,417-425`; `ent:apps/web/src/server/routers/deployments.ts:185,371,458` |
| Compose editing | The web can create/import an app and edit selected `appbay.yaml` values. There is no Compose source editor in `apps/web/src`. | Missing as a product workflow | `ent:apps/web/src/server/routers/apps.ts:141-270,609-731`; `ent:apps/web/src/components/apps/tabs/config-tab.tsx:270-350` |
| Human identity | Caddy Security supplies the user header; protected tRPC procedures require a non-null user. The edge policy currently admits the admin role. | Single privilege level | `ent:apps/web/src/server/edge-identity.ts:1-29,61-73`; `ent:apps/web/src/server/trpc.ts:25-29,102-122` |
| Enterprise authorization and audit | There is no per-action/workspace authorization gate or audit table. Deployment history records outcomes, without an actor or authorization decision. | Proposed | `ent:packages/db/src/schema.ts:56-64`; `ent:apps/web/src/server/routers/deployments.ts:247-257`; `cli:docs/history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-013-rbac-audit-users.md` |
| Secret storage | Manifests carry `vault://` references. Resolution and CRUD currently use a local encrypted vault by default; OpenBao is absent. | Local implementation; external backend proposed | `cli:packages/core/src/schemas/appbay-yaml.ts:243-285`; `cli:packages/core/src/secrets/resolve-for-deploy.ts:99-110`; `cli:packages/core/src/services/vault-service.ts:139-164` |

The product boundary remains useful: `appbay-cli` owns the Compose compiler and host execution; `appbay` owns the web control plane. The private repo still depends on its own `@appbay/core` via `workspace:*` (`ent:apps/web/package.json:16`) and both copies declare `private: true` (`cli:packages/core/package.json:4`, `ent:packages/core/package.json:4`).

## External Ideas

[Haloy's quickstart](https://haloy.dev/docs/quickstart) makes installation, server enrollment, a small app declaration, deploy, and status one visible journey. Its [architecture](https://haloy.dev/docs/architecture) separates client, server, and proxy. AppBay can adopt the clarity of that journey and an explicit client-to-operator boundary while retaining its distinct ability to ingest an upstream Compose file without editing it (`cli:docs/guide/apps.qmd:125`). Haloy's [secret provider guide](https://haloy.dev/docs/secret-providers) exposes provider names in app declarations; AppBay's accepted RFC uses portable `vault://` manifest references with the backend selected per installation (`cli:docs/rfc/RFC-001-consolidation.md:248-251`).

## Coverage

CodeGraph indexed 414 files, 3,052 symbols, and 10,040 edges in `appbay-cli`; 492 files, 3,811 symbols, and 12,331 edges in `appbay`. Symbol trails were checked against complete deploy, secret, editor, and auth function bodies. No browser, live host, OpenBao server, or release artifact was exercised in this review.
