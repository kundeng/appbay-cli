---
spec: SPEC-000
title: Gaps, tiers, and the seam for each
status: proposed
priority: read first
---
# SPEC-000 — Gaps, tiers, and the seam for each

Two repositories, one rule. **`appbay-cli` is the open-source base**: compiler, traits,
CLI, `@appbay/core`. **`appbay` is the enterprise fork**: GUI, multi-user, fleet. The fork
extends the base through seams and never patches under them. An enterprise need that would
change base code is a seam, and the seam ships in the base first.

**Why the rule is needed now.** `appbay/apps/web` depends on `@appbay/core: workspace:*` —
its own copy of `packages/core`, last touched 2026-08-08 — while the base's `packages/core`
is 2026-09-06, `private: true`, unpublished. The fork amended because it could not extend:
`traits/registry.ts` exports no registration; `SYSTEM_APPS` is a `const`
(`system-apps.ts:27`); catalog `type` is `z.enum(["git", "local"])`
(`schemas/catalog.ts:22`); the compiler has no hook points; `TraitCategory: "extension"` is
a comment reading *"user-provided (future)"* (`traits/types.ts:22`). SPEC-012 builds the
seams. SPEC-002 makes the fork consume them. Nothing enterprise can be done cleanly before
those two.

## The gaps

| # | Dockhand capability | Verdict | Tier | Seam | Spec |
|---|---|---|---|---|---|
| 1 | Identity: users, roles, LDAP, OIDC, tokens, audit log; one `authorize()` gate ([F9](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f9)) | **build** | OSS: SSO providers compiled into the edge. Enterprise: RBAC beyond `group`, audit trail, users UI | the caddy-security block `system-apps.ts:100–140` already carries a local identity store, a portal, JWT signing and `transform user`; the `auth` trait's `group`; `caddySecurityPolicy` (`auth.ts:28`) | 008, 013 |
| 2 | Docker-management breadth: 21 pages, 266 handlers ([F10](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f10)) | **absorb what is asked for most; decline the breadth** | Enterprise | core's existing per-app ops (`logs`, `exec`, `shell`, `stats`); Dozzle as a system app | 009 |
| 3 | Backup engine: 37 restic modules | declaration, not engine | OSS | `backup` trait | 007 |
| 4 | Scanning, registries, update tracking | **build, as registered system apps** | Enterprise entries on an OSS seam | `registerSystemApp` (012) | 010 |
| 5 | Multi-host, remote agent | **build** | OSS: the compiler targets a host. Enterprise: agent, fleet operation | `scope`, `project.yaml`, `CompilerContext`, renderer, the four spawn helpers | 006 |
| 6 | Git-per-stack sync | sync semantics on the existing kind | OSS | `git` is already a catalog source type (`catalog.ts:22`) | 011 |
| 7 | Overlay model | nothing to close — [F2](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f2) settles it from source | — | — | — |

## Licences of what may be absorbed

Checked against the GitHub API on 2026-09-24, not from memory.

| Source | Licence | Use |
|---|---|---|
| Finsys/dockhand | **BSL 1.1** (`NOASSERTION` on GitHub; `LICENSE` in tree) | **nothing** — no code, no adaptation |
| louislam/dockge | MIT, TypeScript | UI patterns for a Compose-centric GUI, with attribution |
| portainer/portainer | Zlib, TypeScript | UI patterns, with attribution |
| amir20/dozzle | MIT, Go | run as a system app, not embedded |
| aquasecurity/trivy | Apache-2.0, Go | run as a system app |
| containrrr/watchtower | Apache-2.0, Go | run as a system app, monitor-only |
| renovatebot/renovate | **AGPL-3.0** | not embedded; may run externally |

## Order

**OSS:** 012 → 001, 003, 004, 005, 007 → 006a, 008, 011.
**Enterprise:** 002 → 009, 010, 006b, 013.

Every enterprise row has an OSS seam above it. Do not start a right-column item before its
prerequisite lands.
