---
spec: SPEC-000
title: Gaps not to close, and why
status: proposed
priority: read before SPEC-001..007
---

# SPEC-000 — Gaps not to close, and why

A specification for work *not* to do is worth as much as the other seven, because the
comparison that prompted this investigation invites a feature race AppBay would lose and
should not enter. Each entry names the Dockhand capability, the mechanism behind it, and the
reason AppBay should decline.

**Stated limitation.** These are named surfaces. A named-surface comparison cannot see a
capability the other side has no name for — AppBay's trait compiler is exactly that on
Dockhand's side. Read this as a decision list, not a scorecard.

## 1. A second identity plane — do not build

**Dockhand:** `users`, `sessions`, `roles`, `userRoles`, `ldapConfig`, `oidcConfig`,
`apiTokens`, `auditLogs`, with `roles.environmentIds` scoping a role to a host set and a
central `authorize(cookies)` gate exposing `can(resource, action, envId)`
([F9](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f9)).

**Why not:** RFC-001 §1 made the edge the sole identity authority and deleted AppBay's own
accounts; `appbay admin` exists only to say so. Building per-operator RBAC would recreate
precisely what that RFC removed, and the reasoning still holds — two credential domains
means an operator can be authorized in one and not the other, with no single place to look.
The prior review's advice not to add bearer tokens to the API is the same principle and
should also stand.

**What to do instead:** if per-operator authorization is genuinely needed, express it at the
edge, where the authority already is — the `auth` trait's `group` property is the existing
seam, and `caddySecurityPolicy` already emits role requirements.

## 2. Docker-management breadth — do not chase

**Dockhand:** 21 top-level pages and 266 API handlers covering containers, images, volumes,
networks, registries, an interactive terminal, a container file browser, live host metrics
and an alerts page ([F10](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f10)).

**Why not:** this is a different product category. Dockhand is a Docker management UI whose
stacks page happens to run Compose; AppBay compiles application deployments. Matching the
breadth would cost roughly 100,000 lines of UI to reach parity on capabilities that Docker
Desktop, Portainer, lazydocker and `docker` itself already provide, and none of it advances
the stated purpose. AppBay's GUI should cover *its* model — apps, traits, plans, catalog,
secrets, doctor — which is what the nine existing pages already do.

**What to do instead:** SPEC-002. A smaller GUI that deploys correctly beats a larger one
that drops the routes.

## 3. A backup engine — do not build (build the declaration)

**Dockhand:** 37 modules around restic — repositories, snapshots, retention, restore
targets, destinations, swap and reaping.

**Why not:** owning a backup engine is a product. AppBay's unique contribution is knowing
*which volumes matter for this app*, which the trait already declares. See SPEC-007: emit a
correct invocation from the declared volume list, do not reimplement the tool.

## 4. Vulnerability scanning, registry management, image-update tracking — decline

**Dockhand:** `vulnerabilityScans`, `registries`, `pendingContainerUpdates`,
`templateSources` tables with scheduled tasks behind each.

**Why not:** commodity capabilities with good standalone tools (Trivy, Renovate, Watchtower)
and no interaction with the trait compiler. Adding them buys a longer feature list and a
larger surface to keep correct. AppBay already has `appbay pull` and
`rebuild-cache`; that is the right amount.

## 5. A remote agent — decline for now

**Dockhand:** `hawser`, a WebSocket edge plus a token-authenticated standard mode, with a
per-agent capability list.

**Why not:** it is the transport half of multi-host, and SPEC-006 shows transport is the
*smaller* half — route delivery is the blocker. Building an agent before deciding stage 0
of SPEC-006 would produce a way to reach a host that still cannot serve the app's declared
routes.

## 6. Git-per-stack sync — decline, with one caveat

**Dockhand:** `gitRepositories` and `gitStacks` tables, eight git modules, webhook-driven
auto-sync, deletion reconciliation.

**Why not:** AppBay's catalog sources already provide git-backed app definitions
(`catalogAddSource`, `catalogUpdateSource`, `catalogListSources`), which is the same idea
at the catalog grain rather than the app grain. The grain AppBay chose fits a compiler:
definitions are shared, instances are local.

**Caveat:** if operators ask for per-app git sync, the seam is `catalog-service.ts`, not a
new subsystem — and it should land as another catalog source kind.

## 7. Dockhand's overlay model — nothing to close

There is none. [F2](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f2)
settles it from source: two compose-content reassignments, both line-regex bind-path fixups,
and zero producers of proxy configuration anywhere in `src/`. The category is AppBay's
alone. Set aside.
