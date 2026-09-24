---
thread: dockhand-overlay
rows: NP6
---

# Does Dockhand systematically add deployment concerns to a Compose file?

## The question, and what was seen

**Why.** The prior review judged that Dockhand applies Compose as written, and named that
AppBay's unique category — but it read Dockhand's *manual*, and stated that weakness itself.
A manual cannot show what a program does not do: absence of a headline is not absence of a
capability. The judgement had to be redone from source, or set aside.

**How.** Ask three questions of the pinned tree. Which functions reassign compose *content*
between the point a user's file is read and the point `docker compose` is spawned? What do
those functions do? And is any proxy configuration ever *written*, as opposed to read?
CodeGraph answers the first — call shape, not text matches. Grep answers the third, because
"is this string ever produced" is a text question, and the distinction between a producer
and a reader is then settled by reading each hit.

**What.** `src/appbay-dockhand/dockhand_overlay_surface.sh`.

**Where.** Done, and the topic is set aside as the brief directs.

## Where it stands

Confirmed absent. Dockhand's compose content is reassigned at exactly two points on the way
to the daemon, and both are line-regex rewrites of relative bind-mount paths so that a
Dockhand running inside a container names paths the host daemon can resolve. Neither parses
YAML. Nothing else touches the file. On proxies Dockhand is strictly a reader: it parses
Traefik, Pangolin and caddy-docker-proxy labels *the user wrote* in order to show a
clickable URL, and it never writes one. The category is AppBay's alone.

## The analyses, in order

- **NP6** enumerated the compose-mutation sites, identified both, and separated proxy-label
  readers from writers across the whole source tree.

## NP6 — the compose content variable, from deploy to spawn

**Setting.** `dockhand@99dc1044`, all of `src/` (920 TypeScript files, 17,633 indexed
nodes). Population: every function on the path from `deployStack` to the `docker compose`
child process, plus every occurrence of eight proxy-configuration strings anywhere in
`src/`.

**What it tests.** Whether a runtime overlay model exists — something that takes a plain
Compose file and systematically adds ingress, TLS, exposure, auth, env or secrets.

**Procedure.** Start at `deployStack` (`stacks.ts:3084`) and walk its callees with
CodeGraph. Within `executeLocalCompose`, list every assignment to the variable that holds
the content ultimately written to the child's stdin. Resolve each assigning function and
read it. Separately, count occurrences of `traefik.http.routers`, `traefik.enable`,
`certresolver`, `acme`, `letsencrypt`, `reverse_proxy`, `forward_auth` and
`authorization policy` across `src/`, excluding the generated OpenAPI document, and classify
each hit as a read, a write, or prose. Finally, read the two modules whose names suggest
proxy involvement.

**Role:** Result.

**What was seen.** `finalComposeContent` is assigned at `stacks.ts:1254` (initialised from
the user's content), `:1258` and `:1279`, and read at `:1385` and `:1486`. The two
mutations are `rewriteComposeVolumePaths` (`host-path.ts:566`) and `rewriteBindsToHostDir`.
The first matches lines against
`/^(\s*-\s*)(['"]?)(\.\.?\/[^'":\s]+)(\2)(:.+)$/` and substitutes an absolute host path
when one can be derived; the second does the same for a staged remote directory.
`rewriteComposeVolumePaths` has one production caller. `traefik.enable`, `certresolver`,
`acme`, `letsencrypt`, `forward_auth` and `authorization policy` occur **zero** times. All
seven `traefik.http.routers` occurrences are either `labels[...]` lookups in
`utils/traefik-urls.ts` or settings-page prose; both `reverse_proxy` occurrences are
comments in `utils/caddy-urls.ts` explaining which label key is *not* parsed.

**The instrument, and what it cannot see.** CodeGraph resolves static call edges; a
transform reached through a dynamic import or a runtime-registered plugin would not appear.
Two mitigations: the grep half is independent of call shape and would catch a producer
wherever it lived, and Dockhand's remote paths (`executeComposeViaHawser`,
`stageStackDirOnRemote`) were read directly rather than trusted to the graph.

**Alternatives considered.** Running Dockhand and diffing a deployed container's labels
against its Compose file would be the strongest possible evidence. It was excluded on
proportion: it requires standing up the app, a database and a Docker host under a BSL 1.1
licence, to test a negative that source settles unambiguously.

**Overturning evidence.** A third assignment to the compose content; any code emitting a
`traefik.*` or `caddy.*` label rather than reading one; a template that ships proxy labels
pre-written. The last is worth naming precisely: Dockhand's template sources could hand a
user a Compose file that *contains* Traefik labels, and that would still not be an overlay
model — the labels would be in the file the user then owns and must maintain, which is the
tailoring AppBay exists to remove.

Cites [probe-06](../../raw/probe-06-dockhand-has-no-compose-overlay.yaml),
[F2](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f2).

## Generated facts

<!-- generated: facts -->
*Generated by `src/appbay-dockhand/study_facts.py` from `INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md` and `raw/`. Do not edit by hand.*

#### NP6

**Settles:** F2 · **Status:** run · **Moved:** F2

**Inputs:** `dockhand@99dc1044` `src/`

**Procedure, as written:** CodeGraph callees/callers for the deploy path; enumerate compose-content reassignments; grep proxy-config strings for writers

**Records:**
- `raw/probe-06-dockhand-has-no-compose-overlay.yaml` — **supports**: "Compose content is reassigned at exactly two points between deployStack and the spawn (stacks.ts:1258 rewriteComposeVolumePaths, :1279 rewriteBindsToHostDir), both line-regex bind-path fixups for running inside a container. Every traefik.http.routers occurren

**Findings moved:**
- **[F2]** Dockhand has no runtime overlay model — *settled*, role: Result
  - Setting: `dockhand@99dc1044`, all of `src/`, the path from `deployStack` to the
<!-- /generated: facts -->
