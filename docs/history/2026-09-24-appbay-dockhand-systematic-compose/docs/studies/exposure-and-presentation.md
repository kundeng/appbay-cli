---
thread: exposure-and-presentation
rows: NP7 NP8 NP9
---

# What a user can find, and what a machine can read

## The question, and what was seen

**Why.** The prior review's central thesis was exposure: that the friendliness gap and the
power gap share one cause, and that the documentation names far fewer commands than the
binary ships. That is a measurable claim, and it was measured by reading `index.ts`. The
binary is the authority, so it was re-measured from the binary.

**How.** Parse the built CLI's own `--help`, ask each command for its own help, and compare
against the documentation in the same tree. Then mutation-test the repository's own
docs/CLI consistency check, because a green check proves nothing until it has been shown to
go red.

**What.** `src/appbay-dockhand/cli_exposure.sh`,
`src/appbay-dockhand/docs_check_detects_drift.sh`.

**Where.** Done. Two prior claims refuted, one confirmed and sharpened.

## Where it stands

Presentation is in better shape than the prior review believed. The CLI ships 47 real
top-level commands and the reference documents 46 of them; the gap is `exec` and `run`, not
thirteen. The docs/CLI checker is not inert — it detects both drift classes it claims to,
and the real problem is that nothing runs it, because CI is disabled over the stale
lockfile. What *is* confirmed, and worse than reported, is machine-readability: four of 47
commands can emit JSON.

## The analyses, in order

- **NP7** measured exposure and contained two counting defects; retained and superseded.
- **NP8** re-measured over the correct population with an anchored flag match.
- **NP9** mutation-tested the docs checker three ways.

## NP7 → NP8 — counting the surface, correctly

**Setting.** The built binary from the sandbox build of `9f00b579`, and
`docs/reference/cli-commands.qmd` from the same tree.

**What it tests.** How much of the CLI a user can discover from its own help and its own
reference, and how much a script can consume.

**Procedure (NP8, the executed version).** Parse the `Commands:` block of
`appbay --help`, taking the first token of each line. Subtract the retirement notices —
names declared in `commands/retired.ts`, which print a migration message and exit 1 rather
than doing anything — and commander's built-in `help`. The remainder is the population:
**top-level commands only**. Subcommands (`appbay secrets get`, `appbay edge users`) are
excluded because they are reached through a parent, and counting them inflates both the
surface and the documentation gap. Extract command headings from the reference with
`^#+ +\`?appbay ([a-z][a-z-]*)`. For `--json`, ask each command for its own `--help` and
match `--json` anchored at a word boundary. Run the repository's own checker from the repo
root, where its relative binary path resolves.

**Role:** Result.

**What was seen.** 51 top-level names; 4 retirement notices (`admin`, `auth`, `authelia`,
plus `help`); **47 real commands**. 46 have a heading in the reference; the two without are
`exec` and `run`. Exactly **4** accept `--json`: `doctor`, `list`, `ps`, `status`. The
repository's checker reported 51 commands, 28 docs files scanned, 0 discrepancies.

**Why NP7 was superseded, and what it cost.** NP7 counted `--json` with `grep -c 'json$'`,
which also matches `no-json` — the counts summed to 98 over 51 commands, which is how the
defect announced itself. It also built its "declared" population from `new Command("…")`
across every file under `commands/`, sweeping in subcommand names, so its
"declared but not in help" list was populated with `get`, `set`, `ls`, `rm`, `start`, `stop`
and other subcommands. Both records are retained: the first is what was run, the second is
what it should have been, and the NP rows cite each.

**Relation to the prior figures.** The prior review reported 47 shipped and 34 documented.
The shipped count matches exactly. The documented count does not, and the uncommitted
changes to `cli-commands.qmd` edit two existing sections without adding headings, so the
reference was already complete at this commit. On `--json` the prior review reported 16 of
23 *state-reporting* commands lacking it; this measures all 47, so the numbers are not
directly comparable — but 4 of 47 is the stronger statement and points the same way.

**Overturning evidence.** A documentation surface other than `cli-commands.qmd` that a
reader would reasonably treat as the command reference — the README's command table is the
candidate, and if the prior figure came from there, then both measurements are right about
different documents and the README is the thing to generate.

Cites [probe-07](../../raw/probe-07-cli-exposure-measured-from-the-binary.yaml),
[probe-08](../../raw/probe-08-cli-exposure-top-level-commands.yaml),
[F11](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f11),
[F13](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f13).

## NP9 — proving the checker is a checker

**Setting.** The sandbox copy of `docs/reference/cli-commands.qmd`; the immutable snapshot
is never written. Three mutations and a control.

**What it tests.** Whether `scripts/check-docs-cli.mjs`'s zero-discrepancy result carries
information, or passes vacuously.

**Procedure.** Copy the file aside and install a trap restoring it on every exit path.
Record the baseline. Append a section documenting a command the binary does not have
(`appbay teleport`) and re-run. Restore, append a code block invoking a flag the command
does not accept (`appbay status --telepathy`), and re-run. Restore and re-run as a control.

**Role:** Check.

**What was seen.** Baseline exit 0, 0 discrepancies. Mutation A: 2 discrepancies, exit 1,
both located to the injected lines. Mutation B: 1 discrepancy, exit 1. Control: exit 0.

**What it means.** The checker is sensitive to both failure classes in its own docstring —
a documented command the binary lacks, and a documented flag it does not accept — and its
green result on the shipped tree therefore means the docs and the binary agree. The prior
review's "inert" verdict is most plausibly explained by the `✖ binary not found … exit 2`
path, which this investigation also hit before correcting its working directory. The
actionable problem is adjacent: the check works and nothing runs it, because CI is
disabled over the lockfile.

**Population and exclusions.** Two mutation classes were tested. The checker also reports
undocumented flags — deliberately as a report rather than a failure, per its docstring —
and that asymmetry was not exercised. A checker could be sensitive to the two tested
classes and wrong about the third.

**Overturning evidence.** A green result on either injected mutation.

Cites [probe-09](../../raw/probe-09-docs-cli-check-detects-injected-drift.yaml),
[F12](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f12).

## Generated facts

<!-- generated: facts -->
*Generated by `src/appbay-dockhand/study_facts.py` from `INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md` and `raw/`. Do not edit by hand.*

#### NP7

**Settles:** F11, F13 · **Status:** run (two counting defects; NP8 supersedes) · **Moved:** —

**Inputs:** built binary + docs

**Procedure, as written:** parse `--help`, compare to doc headings, test `--json` per command

**Records:**
- `raw/probe-07-cli-exposure-measured-from-the-binary.yaml` — **inconclusive**: "Procedure defect found on reread: grep -c 'json$' also matched 'no-json' (51+47=98 over 51 commands), and the declared-command list swept in subcommand names from every commands/*.ts file, so 'declared but not in help' listed secrets/edge/catalog subcommands.
  - runs: `runs/cli-exposure-20260924/`

#### NP8

**Settles:** F11, F13, H1 · **Status:** run · **Moved:** F11, F13

**Inputs:** same

**Procedure, as written:** top-level names only, retirement notices subtracted, anchored `--json` match, docs check from the repo root

**Records:**
- `raw/probe-08-cli-exposure-top-level-commands.yaml` — **supports**: "47 real top-level commands after subtracting 4 retirement notices (admin, auth, authelia, help) from the 51 names in --help. 46 have a heading in docs/reference/cli-commands.qmd; only exec and run do not. Only 4 of 47 accept --json: doctor, list, ps, status. 
  - runs: `runs/cli-exposure-20260924b/`

**Findings moved:**
- **[F11]** ~~The docs name only 34 of 47 shipped commands~~ — *refuted*, role: Check
  - Setting: The built binary's own `--help`, top-level names only, against
- **[F13]** Only 4 of 47 commands can emit JSON — *settled*, role: Result
  - Setting: Each of the 47 real top-level commands asked for its own `--help` from the

#### NP9

**Settles:** F12 · **Status:** run · **Moved:** F12

**Inputs:** sandbox copy of `cli-commands.qmd`

**Procedure, as written:** baseline; inject absent command; inject absent flag; restore

**Records:**
- `raw/probe-09-docs-cli-check-detects-injected-drift.yaml` — **supports**: "Three-way mutation test on the sandbox copy: baseline exit 0; a documented-but-absent command (appbay teleport) -> 2 discrepancies, exit 1; a documented-but-absent flag (appbay status --telepathy) -> 1 discrepancy, exit 1; restored -> exit 0. The checker is s
  - runs: `runs/docs-check-mutation-20260924/`

**Findings moved:**
- **[F12]** ~~`scripts/check-docs-cli.mjs` is inert~~ — *refuted*, role: Check
  - Setting: The script run from the sandbox repo root, then run again against two
<!-- /generated: facts -->
