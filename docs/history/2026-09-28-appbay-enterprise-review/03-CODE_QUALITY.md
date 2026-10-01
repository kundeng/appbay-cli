# Code Quality Findings

Review method: CodeGraph symbol trails and impact queries in both repos, followed by full source reads of the cited paths. This is a static review; the findings below do not claim a live exploit or deployment reproduction.

## F1 — Multiple Web Apply Paths

`[S1 HIGH]` `ent:apps/web/src/server/routers/deployments.ts:86-175,185-298,371-419,458-539`; `ent:apps/web/src/server/queue/workers/deploy.ts:144-208`

Capability: deploy from web. Meaning: Up, planner, and full deploy enforce different preconditions and write different outputs. Evidence: `up` writes rendered Compose and calls its own runner, omitting auxiliary files and secret resolution; `enqueue` delegates to a different worker; `fullDeploy` reaches the old private core. `cli:packages/core/src/services/deploy-service.ts:71-185` is a fourth implementation in the OSS base. Disposition: schedule the single deploy path before editor or multi-user release. Effort: architectural.

## F2 — Browser-Supplied Deploy Artifact

`[Q3 HIGH]` `ent:apps/web/src/server/routers/plans.ts:67-87`; `ent:apps/web/src/components/deploy/deploy-planner.tsx:417-425`; `ent:apps/web/src/server/routers/deployments.ts:86-109,371-419`; `ent:apps/web/src/server/queue/workers/deploy.ts:161-169`

Capability: plan and apply. Meaning: an authenticated caller can submit different rendered YAML and auxiliary path/content than the server compiled; the server writes them under the AppBay home and runs Compose. The input schema accepts arbitrary strings for `rendered` and auxiliary paths. `path.join(home, '../../outside')` escapes the home, so the auxiliary path needs a strict server-owned target even before multi-user roles are added. Disposition: fix in single-path cutover; replace artifact-bearing mutation with a server-owned plan ID and revision check. Effort: medium.

## F3 — Authentication Has No Per-Action Authorization

`[S4 HIGH for enterprise]` `ent:apps/web/src/server/trpc.ts:25-29,102-122`; `ent:apps/web/src/server/routers/edge.ts:64-97`; `ent:packages/db/src/schema.ts:56-64`

Capability: multiple operators. Meaning: every authenticated principal can call the same protected mutations, including edge user management; the user context carries no role or workspace membership. Deploy history has no actor. The current edge policy admits admins, so this is an enterprise readiness gap rather than evidence of a non-admin exploit in the present configuration. Disposition: schedule after shared deploy API and before multi-user access. Effort: architectural.

## F4 — Secret Backend Is Not Yet Selectable

`[S1 MEDIUM]` `cli:packages/core/src/schemas/appbay-yaml.ts:243-285`; `cli:packages/core/src/secrets/store.ts:29-85`; `cli:packages/core/src/secrets/resolve-for-deploy.ts:99-110`; `cli:packages/core/src/services/vault-service.ts:139-164`

Capability: portable secret references. Meaning: the accepted RFC chooses one `vault://` manifest notation and an installation-selected backend, but deploy and CRUD instantiate the local vault. `SecretStore.registerProvider()` is constrained by a fixed URI scheme set. The schema rejects four named alternate schemes but does not positively require `vault://`; an unknown scheme can pass validation and fail later. Disposition: refine the backend seam and manifest validation together; preserve local behavior. Effort: medium.

## F5 — Editor Save Contract Is Incomplete

`[Q1 MEDIUM]` `ent:apps/web/src/server/routers/apps.ts:671-715`; `ent:apps/web/src/components/apps/tabs/config-tab.tsx:270-310`; `cli:docs/design/data-architecture.md:50-59`

Capability: editing an app. Meaning: the existing field editor serializes the whole parsed `appbay.yaml` object, writes even when validation fails, and has no file revision or atomic replacement. The `appName` and dotted key inputs are not checked against a discovered app or safe field path before joining them into a filesystem path. This is not a suitable write API for a concurrent Compose editor. Disposition: design a source-owned edit API with path validation, revision check, validation, and atomic write. Effort: medium.

## F6 — Proposed Extension And Deploy Specs Need Reconciliation

`[S12 MEDIUM]` `cli:docs/history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-012-extension-seams.md:18-38`; `cli:docs/history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-002-one-deploy-path.md:11-67`

Capability: enterprise extensions. Meaning: SPEC-012 proposes arbitrary compiler hooks, including `afterRender`, without a rule preserving compile and safety invariants. SPEC-002 names the fork's `fullDeploy` as the target, while the current OSS deploy entry point is `deploy()` with changed options and behavior. Both drafts are still proposed and are not implementation authority. Disposition: refine as active code is reconciled; prove an external consumer against the published package and Bun binary. Effort: medium.

## F7 — Shared Database Draft Crosses Unsettled Boundaries

`[S11 MEDIUM]` `cli:docs/history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-014-shared-database-layer.md:60-114`

Capability: shared database service. Meaning: the example unconditionally excludes bundled `db` even though the overlay is conditional; a missing provider would leave no database. It also proposes writing provider credentials into namespace values while leaving secret ownership and migration open. Disposition: keep proposed, after the value/secret authority and migration design are settled. Effort: architectural.

## Verification Boundary

`appbay-cli` has an active S48 with review round 2.10 and both-guest journeys 3.1 pending (`cli:specs/S48-review-green/spec.md:127-128`). Its current worktree already has unrelated modifications, including this unfinished work. The private `appbay` worktree was clean before CodeGraph initialization and remains clean afterward. This review performed no test suite, browser, or guest run; it does not update prior test verdicts.
