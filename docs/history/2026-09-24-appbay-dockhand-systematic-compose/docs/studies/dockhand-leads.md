---
thread: dockhand-leads
rows: NP14
---

# Where Dockhand goes further, and how it is built

## The question, and what was seen

**Why.** A maintainer deciding what to do about Dockhand needs more than a list of things
it has. They need the mechanism behind each, because the mechanism is what determines
whether closing the gap is a feature, a refactor, or a change of shape.

**How.** For each lead, name the code in Dockhand that implements it and AppBay's
counterpart or its absence. Prefer structural measures — how many call sites carry the
parameter, what the transport is — over feature names.

**What.** `src/appbay-dockhand/dockhand_leads.sh`.

**Where.** Done. One section's command path was malformed and that line was captured
separately; everything else ran.

**Stated limitation, carried wherever this page is used.** This compares *named* surfaces.
A named-surface comparison cannot see a capability the other side has no name for —
AppBay's trait compiler is exactly such a capability on Dockhand's side, which is why
[dockhand-overlay](dockhand-overlay.md) was settled from call shape instead. Read this as
"what Dockhand has built that AppBay has not", never as a scorecard.

## Where it stands

Dockhand leads on multi-host, multi-user and GUI breadth as expected, and on more besides:
backups, scheduled maintenance, git-driven deploys, vulnerability scanning, notifications,
registries and a remote agent. The mechanisms differ in kind. Multi-host is an *ambient
parameter* — `envId` on every call, over an HTTP transport — which AppBay cannot adopt
cheaply because its transport is a local spawn and, more importantly, its route delivery is
a local file write. Multi-user is a *data model plus one gate*, which AppBay has
deliberately declined. GUI breadth is *volume*, an order of magnitude of it.

## The analyses, in order

- **NP14** established each lead's mechanism side by side with AppBay's counterpart.

## NP14 — mechanism, not feature name

**Setting.** `dockhand@99dc1044` `src/` against `appbay-cli-mac@9f00b579`
`packages/core/src` and `appbay-mac@d8f557bc` `apps/web/src`. Population: the three leads
named in the brief, plus every Dockhand subsystem with a database table and a scheduled
task behind it.

**What it tests.** For each lead, what a maintainer would have to build.

**Procedure.** For multi-host: read the `environments` schema, count `envId` references and
files, identify the transport function, then find AppBay's equivalent transport and its
route-delivery call. For multi-user: list the identity tables, read the authorization gate's
interface, count licence checks, and compare against AppBay's edge-user command surface.
For the GUI: count files, lines, top-level pages and API handlers on both sides. For the
remainder: count modules and name the tables.

**Role:** Contrast.

**What was seen.** *Multi-host*: an `environments` row per host carrying address, protocol,
TLS material, a `connectionType` of `socket | direct | hawser-standard | hawser-edge`, and
agent metadata; `envId` appears 2,822 times across 255 files; the transport is
`dockerFetch(path, opts, envId)` at `docker.ts:789`. AppBay's `containerExec`,
`containerSpawnSync`, `containerSpawn` and `containerCompose` take `appbayHome` and spawn a
local binary; `services/deploy/route.ts:35,45` install every route with
`join(appbayHome, aux.path)`; `traits/types.ts:5-6` states the single-node assumption.
*Multi-user*: `users`, `sessions`, `roles`, `userRoles`, `ldapConfig`, `oidcConfig`,
`apiTokens`, `auditLogs`; `roles.environmentIds` scopes a role to a host set; one
`authorize(cookies)` gate with `can(resource, action, environmentId)`; 5 `isEnterprise`
checks. AppBay: `appbay edge users list | create | reset-password`, with roles expressed as
the `group` property on the `auth` trait. *GUI*: 700 files / 129,226 lines / 21 pages / 266
API handlers versus 136 files / 25,550 lines / 9 pages. *Elsewhere*: 37 restic-backed backup
modules, 10 scheduled tasks, 8 git modules with webhook auto-sync, a `vulnerabilityScans`
table, 19 notification modules, registries and template sources, and the `hawser` agent.

**What the numbers mean, and what they do not.** 2,822 `envId` references is not a count of
work to do; it is evidence that the host dimension is *ambient* rather than confined to a
transport layer, which is the thing a maintainer needs to know before proposing to add one.
129,226 versus 25,550 lines is a crude instrument — it says the GUI gap is an order of
magnitude and nothing about quality, and the AppBay snapshot is six weeks older.

**Population and exclusions.** Dockhand's Enterprise features were read, not exercised, so
claims about RBAC describe the code rather than a running system. Backup, scanning and
notification module counts are file counts, which overstate a subsystem split into many
small files and understate one that is not.

**Overturning evidence.** For multi-host, a Dockhand deploy path that bypasses `envId`, or
an AppBay code path that already reaches a non-local daemon. For the GUI, a page count that
does not survive excluding shared component directories.

Cites [analysis-14](../../raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml),
[F8](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f8),
[F9](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f9),
[F10](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f10).

## Generated facts

<!-- generated: facts -->
*Generated by `src/appbay-dockhand/study_facts.py` from `INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md` and `raw/`. Do not edit by hand.*

#### NP14

**Settles:** F8, F9, F10 · **Status:** run (one malformed path; that line captured separately) · **Moved:** F8, F9, F10

**Inputs:** both trees

**Procedure, as written:** per lead, name the implementing code and AppBay's counterpart or absence

**Records:**
- `raw/analysis-14-dockhand-leads-and-their-mechanisms.yaml` — **supports**: "Multi-host: Dockhand parameterises every call by envId (2822 references, 255 files) over a docker HTTP API (dockerFetch at docker.ts:789) with four connection types; AppBay's spawn layer (containerExec/containerSpawn/containerCompose) takes no host and route 

**Findings moved:**
- **[F8]** Dockhand's multi-host lead is an `envId` parameter, not a subsystem — *settled*, role: Result
  - Setting: `dockhand@99dc1044` `src/`, versus `appbay-cli-mac@9f00b579`
- **[F9]** Dockhand's multi-user lead is environment-scoped RBAC with an audit trail — *settled*, role: Result
  - Setting: Dockhand's `db/schema/index.ts` and `server/authorize.ts`, versus AppBay's
- **[F10]** Dockhand's GUI lead is an order of magnitude, and it is the product — *settled*, role: Contrast
  - Setting: Dockhand `src/routes` + `src/lib/components`, versus `appbay-mac@d8f557bc`
<!-- /generated: facts -->
