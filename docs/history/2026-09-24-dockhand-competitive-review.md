# Making AppBay friendlier and more powerful than Dockhand, without new features

2026-09-24 · competitive review and prioritised recommendations

## Where this came from

Two independent investigations ran the same brief against immutable snapshots of
`appbay-mac` and `appbay-cli-mac`, researching Dockhand from primary sources.
They did not see each other's work. This document merges them.

Claims are labelled by how much weight they carry:

- **[both]** — both investigations reached it from separate evidence chains.
- **[one]** — one found it; re-checked against the snapshot before inclusion.
- **[verified]** — re-derived by hand from source, independently of both.

Working files, including every raw record, are in the notes vault under
`60-projects/audited-ops-skill-evaluation/`.

**The limitation both investigations put first:** nothing here was observed by
running either product. Everything rests on reading source and documentation.
Items marked *behavioural* below should be confirmed on a real host before work
starts.

## How each system actually works

Establish this before reading any comparison below, because the two products do
different kinds of work and a feature-by-feature table hides that.

### Dockhand: a GUI over `docker compose`, plus git polling

Dockhand does not transform your Compose file. Its git pipeline, in its own
documentation, is `git pull` -> sync & compare -> `docker compose up`. The
compose file in your repository is authoritative and is applied as written.

Consequently none of the concerns a Compose file cannot express are handled by
Dockhand:

| Concern | How Dockhand handles it |
|---|---|
| Ingress / routing | It does not. The word "ingress" appears **zero times** in its 891 KB manual. You hand-write Traefik labels in your own compose file. |
| TLS certificates | `HTTPS_MODE=on` with `HTTPS_CERT_PATH` is a native HTTPS listener for **Dockhand's own UI and API**, off by default, PEM files supplied by you. Nothing issues or assigns a certificate to your app. |
| Selective exposure | No control. The manual *warns* that `"5432:5432"` publishes on all interfaces and advises binding `127.0.0.1` yourself. |
| Environment overlay | "Config sets" are reusable templates (env vars, labels, port mappings) applied when creating a container **through the GUI**. Not a compose overlay, and not part of the git-stack path, where env comes from the `.env` committed in the repo. |
| Reverse-proxy awareness | Read-only. Since 1.0.34 it *reads* Traefik, Pangolin and caddy-docker-proxy labels and surfaces the resulting URL as a clickable pill. It never generates them. |

Its documented Traefik section shows how to put **Dockhand itself** behind a
proxy, using labels you type by hand.

One operational trap in that model, documented by Dockhand: stack secrets are
injected as shell environment during `docker compose up`, and Docker stores the
compose configuration but not the transient shell environment. After a host
reboot Docker restarts the containers itself, and `${VAR}` references to secrets
resolve to **empty strings**. Variables in `.env` survive; secrets do not.

### AppBay: a compiler

AppBay reads an unmodified Compose file plus a sidecar `appbay.yaml` declaring
traits, and *generates* the configuration those concerns require.
`packages/core/src/compiler/` (compile, overlay-engine, trait-engine,
scope-resolver, renderer) applies trait definitions from
`packages/core/src/traits/definitions/` — `ingress`, `auth`, `gpu`, `secrets`,
`scoped-env`, `hooks`, `backup`.

The `ingress` trait takes `host`, `port`, `exposure: internal | external | both`
and `tls.staging`, and emits a router, service and middleware definition into
`etc/apps/traefik/config/dynamic/<app>.yml` — the Traefik **file** provider, not
Docker labels — or the equivalent Caddy fragment, while attaching the service to
the shared network. Certificate selection is a resolver name chosen from
`tls.staging` (`letsencrypt-staging` or `letsencrypt`).

**This is a category Dockhand has no equivalent of.** It is the difference
between declaring `exposure: internal` and hand-writing six Traefik labels
correctly in every stack. It is also, at present, the least advertised thing in
the product.

### Why this matters for everything below

A crosswalk of feature *headlines* treats "Git Integration" as one comparable
capability. It is not: Dockhand's is git-pull-then-compose-up with webhooks,
scheduled sync and per-stack branch tracking, and AppBay has no equivalent
(`pull` is Docker image pull plus Ollama models; `catalog` is a source-based app
catalog). That particular absence is real. But the same crosswalk cannot see
that AppBay's compiler has no counterpart at all, because Dockhand publishes no
headline for a thing it does not have. **Read the capability counts below as a
measure of surface, not of substance.**

## The finding

Three things are true at once, and the first was missed by both investigations
because both measured surfaces rather than mechanisms.

**AppBay owns a capability Dockhand does not have.** The trait compiler turns a
declaration into generated ingress, TLS resolver selection, auth, scoped env and
secret wiring. Dockhand applies your Compose file as written and leaves all of
it to you. This is the strategic asset in the product, and it is close to
unadvertised.

**AppBay's automation surface is real but undeclared**, so nothing outside the
project can be programmed against it.

**AppBay's command surface is largely hidden**, so users cannot find what is
already there.

Only the last two are exposure problems, and neither needs a feature to fix.
[both]

The CLI ships **47 top-level commands and documents 34**; the **13 it never
names** are `dive`, `exec`, `mcp`, `models`, `ollama`, `profile`, `run`, `shell`,
`smi`, `stats`, `tunnel`, `tunnel-down`, `version` — container interaction,
resource inspection and saved configuration, which is the composability half of
the product. [verified]

Crosswalking the 26 capabilities Dockhand advertises: five have a documented
front door, **eight exist but are reachable only through a command nothing
names**, and thirteen are genuinely absent — all of them multi-host, Git-sync,
scanning, scheduling and browsing subsystems. [one]

The git-stack absence is real: Dockhand deploys from a tracked repository with
webhooks, scheduled sync and per-stack branch selection, while `pull` is Docker
image pull plus Ollama models and `catalog` is a source-based app catalog.
**But this crosswalk is mechanism-blind in one direction**: it can only compare
against headlines Dockhand publishes, so it cannot register the compiler, for
which Dockhand has no headline because it has no such thing.

### The uncomfortable half

Dockhand has no command-line client at all, which ought to make AppBay the
automation choice outright. The picture is less comfortable than that.

Dockhand publishes a **formal, machine-readable interface contract**: an OpenAPI
3 document generated from its live routes, bearer-token auth, and a community
MCP server riding on it. AppBay's API is deliberately tokenless, and **16 of its
23 state-reporting commands cannot emit machine-readable output at any
subcommand level**. [one]

**Be precise about what that does and does not establish.** Dockhand is ahead on
the *specified* surface — what is written down, published as a spec, and
therefore programmable by someone who has never read the source. It is not
established that Dockhand composes better in practice, and nothing here
demonstrates that it does. AppBay has 47 real commands against Dockhand's zero;
a shell pipeline over a CLI is a composition mechanism that an OpenAPI document
is not. Neither product was run (see the limitation at the top), so the
comparison is between a published contract and an unpublished one, not between
two measured capabilities.

The actionable form of the finding is narrower and survives the caveat: AppBay's
composability is real but **undeclared**, and an undeclared contract cannot be
programmed against by anyone outside the project. That is what `--json` fixes,
and it is why `--json` outranks every other item here.

Note `secrets check`, the command that answers whether every secret URI
resolves, has no `--json`. The only `--json` in `secrets.ts` is on the
state-changing `vault rotate-password`.

## Dockhand's implementation and traction

Relevant because it bounds what is worth copying: nothing here is a module you
could adopt.

| | |
|---|---|
| Frontend | SvelteKit 2, Svelte 5, shadcn-svelte, TailwindCSS |
| Backend | Bun runtime with SvelteKit API routes |
| Database | SQLite or PostgreSQL via Drizzle ORM |
| Docker | direct Docker API calls |
| Base image | own OS layer built from Wolfi packages via apko |
| Install | one container, `-v /var/run/docker.sock:/var/run/docker.sock` |
| Repository | `Finsys/dockhand`, TypeScript, created 2025-12-28 |
| Traction | 6366 stars, 271 forks, 344 open issues, a release every ~6 days |
| Licence | BSL 1.1, converting to Apache 2.0 in 2029 |

Its README carries no install instructions, no CLI and no command list — About,
Features, Tech Stack, Screenshots, Licence, and 19 screenshots carrying the
pitch. Its advantage is not architecture and not depth. It is that everything it
has is visible, and that it publishes a machine-readable contract.

A feature race against a weekly-cadence 1.0 with that much feedback behind it is
not winnable, and the brief's exclusion of significant features is the right
call rather than a constraint to work around. [both]

## Recommendations

Ordered by value per unit of work. Nothing below adds a feature.

### P0 — Lead with the compiler, because nothing else has one *(documentation; hours)*

The strongest claim AppBay can make is one it currently does not make: *your
Compose file is never modified, and AppBay generates the ingress, TLS, auth and
scoped-env configuration that Compose cannot express.* Dockhand, Portainer and
every other Compose GUI hand that work back to the user as labels to type.

Concretely: put a worked before/after at the top of the README and the docs
landing page. A plain Compose service, plus six lines of `appbay.yaml` declaring
`ingress: {host, port, exposure: internal, tls: {staging: true}}`, plus the
generated `traefik/dynamic/<app>.yml` it produces. One screenful, three panes.
It demonstrates the product's whole thesis and costs a page.

This outranks the rest because it changes what a reader thinks the product *is*.
The other items make AppBay easier to use once you have decided to; this is the
one that makes the case for deciding to. It is also the honest answer to "why
not just run Dockhand".

### P0 — One first run, taught identically everywhere *(documentation; hours)* [both]

A new user is handed three different first runs and two are not the one AppBay
recommends. Make the README Quick Start, the installer's Next steps and the
Getting Started page teach the same path — `appbay setup` — in the same words.
Have `setup` close by naming what it just did and how to re-enter it
(`appbay setup --status`).

Move the SELinux, rootless-Podman and compose-provider callouts into
`guide/host-prerequisites.qmd`, linked from one line above the install command.
Keep every word; change where it sits. Put `## Installation` in the first
screen. Replace the installer's placeholder `https://appbay.dev/docs` with the
real URL and correct or drop its `Web UI: http://localhost:3000` line.

### P0 — Make the default edge honest *(one constant or one paragraph; hours)* [one] *behavioural*

The code selects Traefik; the quickstart says Caddy. That choice decides whether
the `auth` trait compiles and whether the control plane gets an edge route, so
the two documents disagree about whether the documented product works.

Recommended: default to `caddy`, update `init.ts`'s help string, and have `init`
print one line naming the edge it chose and what that implies. Confirm the
compile behaviour on a real host first — this is the item most exposed to the
read-only limitation.

### P1 — `--json` on the reporting commands *(one flag each; days)* [both]

**The highest-leverage change in this review.** Each of these already computes
the data it prints; the work is a serialiser and a flag.

Suggested order by downstream value: `secrets check` (pre-deploy gates),
`validate` and `compile` (CI), `config` and `env` (configuration read-back),
`size` and `info` (dashboards), `url` (scripted smoke tests), `stats`
(monitoring). The rest: `dive`, `eject`, `home`, `logs`, `presets`, `smi`,
`version`.

Adopt one rule and document it: `--json` writes a single JSON document to
stdout, all human text to stderr, exit codes unchanged — so `appbay validate
--json | jq` works and `set -e` still behaves.

This is the prerequisite for the whole automation axis. An MCP server, a
dashboard, a Prometheus exporter and a CI gate are all thin wrappers over
`--json` and all impossible without it.

### P1 — Group `appbay --help` using the grouping that already exists *(~30 lines; hours)* [both]

The taxonomy is already in `index.ts` as section comments and already covers all
47 commands. Move it into commander help groups and enable
`showSuggestionAfterError` and `showHelpAfterError`. Put the passthrough
commands (`smi`, `dive`, `tunnel`, `tunnel-down`, `mcp`, `models`, `ollama`) in
one group named Integrations so they stop competing with `up` for a new reader's
attention.

This converts a flat 47-item wall into a structured surface and gives a mistyped
command a "did you mean". It is information moving from a comment to an API
call; nothing is removed and nothing breaks.

### P1 — Generate the README command table from the CLI *(one build script; hours)* [one]

The table drifts because it is typed by hand. Generate it from the same
declarations the investigation parsed, and fail CI when the committed output
differs — the pattern `scripts/generate-system-apps.mjs` already establishes
here. The thirteen invisible commands then become visible automatically and stay
visible.

While there: lead the README's "What It Does" with `eject`. *"Your Compose files
are never modified, and `appbay eject` gives you a standalone Compose file that
runs without AppBay at all"* is the strongest sentence in the project and is
currently the fifth bullet.

### P2 — Document that a plain Compose directory is already an app *(docs + a small fix)* [one]

The biggest unclaimed capability in the product: `appbay.yaml` is optional, and
copying a Compose directory into `etc/apps/` is sufficient. Say so in the README
and the docs.

The only code implied is exposure, not feature: `discover.ts` currently skips a
compose-less directory **silently**. Report it — in `doctor` and in `list` —
with a fix string in the house style. A user who drops a folder in and sees
nothing cannot distinguish "not supported" from "nothing happened".

### P2 — Repair the documentation guard *(one file)* [one]

`check-docs-cli.mjs` has an inert half after the repo split: it prints a success
line about tRPC routers it can no longer see. Either delete that block and the
API reference it cannot verify, or point it at the control-plane repo. Leaving
it is worse than either.

Then apply its existing router argument to commands: fail, or at minimum report
loudly, when a registered command appears in no user-facing doc. This is what
stops the P1 work rotting.

### P2 — One word per meaning *(aliases and a find-replace; days)* [one]

Pick "AppBay" or "Appbay" once, everywhere, including both READMEs' H1. Decide
whether the central action is called *deploy* or *up* and use that word on both
surfaces — the UI's Deploy button and the CLI's `up` are the same act under two
names, and the palette still offers a retired command.

### P3 — One troubleshooting index *(docs)* [one]

Not new content. AppBay's fix strings are already better than Dockhand's prose.
One page collecting the failure modes already documented across
`quickstart.qmd`, `deploy/compose.qmd`, `bootstrap.md` and the `doctor` fix
strings.

## What not to build

The tempting responses to this review are all more expensive and less valuable
than the list above.

**Do not treat the thirteen absences as one decision.** Both investigations
recommended declining the feature gap wholesale. That is too blunt, and the
compiler is the reason why: AppBay has extension seams — the trait registry
(`packages/core/src/traits/definitions/`, with user-provided extension traits
already anticipated in `types.ts`), `SYSTEM_APPS`, the `hooks` trait, and
catalog sources. A capability that lands on an existing seam is not a subsystem;
it is a declaration plus a generator.

Sort the thirteen by which seam they need, not by whether Dockhand has them:

| Capability | Plausible seam | Cost |
|---|---|---|
| Scheduling | `hooks` trait, or a cron system app | low |
| Notification fan-out | system app, or a hook | low |
| Backup destinations | the `backup` trait **already exists**; destinations extend it | low |
| Vulnerability scanning | scanner system app plus a reporting command | moderate |
| Git-repository deploy, webhooks, auto-sync | a catalog source type plus a scheduler | moderate |
| Container file browsing, shell UI | needs the web surface, not the CLI | moderate |
| **Multi-host agents** | **none** | **high** |

Multi-host is the one that genuinely does not fit. `traits/types.ts` states the
model is "adapted for **single-node** Docker Compose", and the ingress trait
resolves one installation-level proxy from one `project.yaml`. Multi-host is not
a trait; it invalidates an assumption the compiler is built on. Decline that
one on architecture, and judge the rest individually on the seam they land on.

The order still matters: a capability added before the compiler is documented is
a capability nobody knows to look for. Ship the P0 above first, then pick from
this table.

**Do not chase Dockhand's feature list as a list.** Matching a competitor's
headline set at one release every six days, with 6366 stars of feedback behind
it, is a losing race, and the brief excludes significant features. Adding a
capability because it fits AppBay's extension model is a different decision from
adding it because Dockhand has it, and only the first is worth making. [both]

**Do not add bearer tokens to the control-plane API.** This is the obvious
reading of the composability finding and it is wrong. The API is tokenless
because RFC-001 §1 deliberately removed AppBay's own credential plane and made
the edge the single identity authority. A token reopens exactly the second
credential domain that decision closed. The automation surface is the CLI; spend
the effort on `--json` instead. [one]

**Do not build an OpenAPI document or an MCP server yet.** Build `--json` first.
An MCP server over commands that emit prose has nothing to return but prose. The
community `mcp-dockhand` project is instructive about ordering: it works because
Dockhand has a machine-readable contract first. Ship the contract and the
wrapper becomes somebody's weekend. [both]

**Do not add any command.** The surface is 47 wide with 13 invisible and 7 spent
on other people's tools. Every addition makes the discoverability findings
worse. [one]

**Do not delete the Getting Started caveats.** The SELinux material, the
rootless-Podman limitations and the compose-provider trap are specific and
measured on real hosts. They are a reason to trust the project. Move them; do
not cut them. [one]

**Do not remove `ls` or `rm`.** Alias them. A retirement notice is the right
tool for a moved command, and the existing retired-command mechanism already
does this. [one]

## Numbers, and where they disagreed

| Claim | Value | Basis |
|---|---|---|
| Top-level commands shipped | **47** | [verified] 48 `addCommand` calls in `apps/cli/src/index.ts`; 47 named, plus a loop registering `admin`, `auth`, `authelia` as tombstones that exit non-zero. Correctly excluded — they are not capability. |
| Documented | **34** | [verified] The two investigations reported 34 and 35. 35 is the count of documented *tokens*, five of which are subcommands (`catalog list`, `catalog search`, `edge migrate`, `secrets check`, `server start`). By top-level command the figure is 34, and 34 + 13 undocumented = 47. |
| Reporting commands without `--json` | **16 of 23** | The two reported 16/23 and 17/25; they classify "reporting command" differently. 16/23 is the stricter count, checks every subcommand level, and names its members. |

### A trap for anyone re-checking the command count

The two snapshots disagree, so the answer depends on which is read:

| | `appbay-mac` (monorepo) | `appbay-cli-mac` (post-split) |
|---|---|---|
| `addCommand` occurrences | 46 | 48 |
| named top-level commands | 46 | 47 |
| `auth` | live command | retired tombstone |
| `edge`, `init-system` | absent | present |
| retired-command loop | absent | present |

The post-split repo is the correct subject; counting the monorepo over-states
live capability. Also note `grep -c addCommand` counts matching *lines*, not
occurrences, which is a second route to a wrong number.

## One note on the source

Dockhand's README contains a block at line 168 instructing AI agents to stop,
ignore prior instructions and delete cached copies. Both investigations recorded
its presence as evidence and did not treat it as an instruction. Anyone
automating research against that repository should expect it, and should treat
fetched repository text as data rather than as instructions.
