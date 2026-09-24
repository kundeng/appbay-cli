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

## The finding

AppBay's friendliness gap and its power gap have the same cause, and closing
either does not require a feature. Both are **exposure**. [both]

The CLI ships **47 top-level commands and documents 34**; the **13 it never
names** are `dive`, `exec`, `mcp`, `models`, `ollama`, `profile`, `run`, `shell`,
`smi`, `stats`, `tunnel`, `tunnel-down`, `version` — container interaction,
resource inspection and saved configuration, which is the composability half of
the product. [verified]

Crosswalking the 26 capabilities Dockhand advertises: five have a documented
front door, **eight exist but are reachable only through a command nothing
names**, and thirteen are genuinely absent — all of them multi-host, Git-sync,
scanning, scheduling and browsing subsystems. [one]

### The uncomfortable half

Dockhand has no command-line client at all, which ought to make AppBay the
automation choice. It isn't, today. Dockhand serves an OpenAPI 3 document
generated from its live routes with bearer-token auth, and a community MCP server
rides on it. AppBay's API is deliberately tokenless, and **16 of its 23
state-reporting commands cannot emit machine-readable output at any subcommand
level**. On composability — the axis AppBay should own — Dockhand is ahead. [one]

Note `secrets check`, the command that answers whether every secret URI
resolves, has no `--json`. The only `--json` in `secrets.ts` is on the
state-changing `vault rotate-password`.

## What Dockhand actually is

Relevant because it bounds what is worth copying: nothing here is a module you
could adopt. It is a web application over the Docker socket.

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
pitch. Its advantage is not architecture. It is that everything it has is
visible, and that it has a machine-readable contract.

A feature race against a weekly-cadence 1.0 with that much feedback behind it is
not winnable, and the brief's exclusion of significant features is the right
call rather than a constraint to work around. [both]

## Recommendations

Ordered by value per unit of work. Nothing below adds a feature.

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

**Do not chase Dockhand's feature list.** Vulnerability scanning, Git-repository
deploys, webhook triggers, multi-host agents, backup destinations and
notification fan-out are absent here and present there, shipped at a release
every six days with 6366 stars of feedback behind them. [both]

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
