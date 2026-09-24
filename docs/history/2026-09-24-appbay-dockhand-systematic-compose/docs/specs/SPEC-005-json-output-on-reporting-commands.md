---
spec: SPEC-005
title: Machine-readable output on every reporting command
closes: F13
status: proposed
priority: 5 — medium value, medium effort, unblocks the rest
---

# SPEC-005 — Machine-readable output on every reporting command

## Requirement

Every command whose purpose is to report state emits its full result as JSON under
`--json`, with a stable shape. Text output remains the default and is derived from the same
value, not produced alongside it.

## Why

Four of 47 commands accept `--json`: `doctor`, `list`, `ps`, `status`
([F13](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f13)). Everything
else — `info`, `size`, `url`, `home`, `env`, `config`, `catalog`, `presets`, `secrets`,
`edge`, `stats`, `models`, `profile`, `validate`, `compile` — is human-readable text only.
This is the concrete form of the prior review's exposure thesis, and it is upstream of
several other asks: an MCP server built over text output would re-parse what the CLI
already knows, and any web/CLI convergence (SPEC-002) is easier when both consume one
typed result.

## Design, on existing seams

The four commands that already have `--json` establish the pattern; follow it rather than
inventing a second one. Read `apps/cli/src/commands/status.ts` and its
`__tests__/status-json.test.ts` first — the latter is the shape to copy.

The structural change is to stop `console.log`-ing as a side effect of computing. Each
command becomes:

```
action() -> result object  (pure, testable)
render(result) -> string   (text)
--json ? JSON.stringify(result) : render(result)
```

`apps/cli/src/utils/formatting.ts` already holds the text helpers, so `render` has a home.
`apps/cli/src/utils/deploy-report.ts` is the worked example of a command result modelled as
data with a separate renderer, and it has its own tests.

Do this in the order the consumers need it — `info`, `url`, `size`, `env`, `config`,
`catalog`, `validate`, `compile` first, since those are what a script or an agent asks for.

Two conventions to fix now rather than later:
- **Errors go to stderr; `--json` output on stdout is a single JSON document.** A banner
  printed to stdout spoils the parse — the failure mode the audit helper's own contract
  warns about.
- **A non-zero exit still emits a JSON document** describing the failure when `--json` was
  asked for, rather than bare text. `compile`'s error path is the one that matters most.

## What it must not break

- **The four existing `--json` shapes are a contract.** `status --json` in particular has a
  test pinning it. Extending is fine; renaming is not.
- **Text output stays the default.** This is an addition; no human-facing output changes.
- **Secret redaction.** The text path redacts generated passwords (`[REDACTED]` in
  `probe-04`'s compile output). The JSON path must redact identically — emitting the
  structured form *unredacted* would be a regression that looks like a feature.
- **`check:docs-cli` will start failing** as flags appear that the docs do not mention. It
  reports undocumented flags rather than failing on them (the asymmetry is deliberate), but
  update `docs/reference/cli-commands.qmd` in the same change.

## How to verify

1. Re-run NP8 (`src/appbay-dockhand/cli_exposure.sh`): the `with --json` count must rise
   from 4 toward 47, and the list is the progress measure.
2. Every `--json` output parses as a single JSON document with `jq -e .` and nothing on
   stdout before it.
3. A test per converted command asserting that text and JSON describe the same state — the
   drift that makes dual-output commands untrustworthy.
