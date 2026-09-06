---
spec_id: S48-review-green
status: ACTIVE
closed_as: null
since: 2026-09-06
until: null
epic: correctness
features: [restart-through-deploy, journeys-workdir, cli-spawns-through-runtime, scheduled-findings-closed, review-rounds]
supersedes: []
superseded_by: null
depends_on: [S47-converge-chain]
anchors: [data-architecture]
---

# S48: fix what the reviews already found, then review again until a round comes back clean

# 1 · Requirements

Kun, 2026-09-06: not ready for a human review; the open rows and the two dated review sets
hold findings that were scheduled and never taken, and the agent waited to be told each one
was a defect. This sprint takes every finding that is fixable in this tree without an owner
decision or an external resource, then runs internal review rounds over the deploy path and
its callers, fixing what each round finds, until a round returns nothing above LOW.

## Mental model

- **Green** means: every SCHEDULE disposition in `docs/history/*-review/03-CODE_QUALITY.md`
  and every open ledger row is closed or carried to a named sprint; a fresh review round
  over the deploy path and the CLI commands that reach it finds nothing above LOW; core and
  CLI tests, `tsc`, the arch rules, the repo's `check:*` scripts, and the deploy-reporting,
  apply-success and lifecycle journeys on both Lima guests pass.
- **Not in this sprint, with the destination named:** the config loader that replaces 34 raw
  `process.env` reads (S49, drafted at close, with the inventory); eslint adoption (S49);
  issue #11 (ship the injector, a feature); D1, D2, D3 and ledger rows 22, 28 (Kun's); issue
  #75 (needs a public host); issue #12 (a trait owns its converge).

## Requirements

1.1 `appbay restart` SHALL stop through the same code `appbay down` uses and start through
    `deploy()`, so it observes what it started and installs routes; its private render
    writer SHALL be gone (ledger row 40).
1.2 EVERY journey that ran `cd /home/ubuntu` SHALL take the directory from `WORKDIR`,
    defaulting to the multipass home, and at least three SHALL run on the Lima guests
    (row 42).
1.3 NOTHING in core SHALL name `apps/web` as a caller; the retired `RunningAppsDiscoverer`
    SHALL be gone (row 12).
1.4 `compile()` SHALL be handed `appbayHome` and SHALL not derive it from `appsDir` (F13).
1.5 THE KeePass database path and key file SHALL be resolved in one function (S3 LOW).
1.6 `server start`'s health wait SHALL use `fetch`, not a spawned `curl`; `checkGpu` SHALL
    report `unknown` when `nvidia-smi` is absent (Q5, Q1 LOW).
1.7 THE CLI SHALL not spawn the container binary itself: `logs`, `exec`, `pull`, `dive`,
    `mcp`, `tunnel`, `models`, `ollama`, `update` and `up --tail` go through `runtime/`
    (F17). Host-tool spawns in `init-system`, `setup`, `fixfs`, `size`, `stats` stay.
1.8 THE `docker.ts` wrapper comment SHALL say why the wrappers exist (the CLI's home
    resolver also reads the CLI-side system config), or the wrappers SHALL go (S10 LOW).
1.9 EVERY exported type knip lists as unused SHALL lose its `export` or its reader SHALL be
    named.
1.10 EACH review round SHALL read function bodies, cite lines, and record its findings with
    dispositions in this spec's log; a finding fixed in a round SHALL carry the commit.

## Decisions & Corrections

**2026-09-06** — Kun: "fix up and run full internal code reviews iteratively until
everything is finally green", and "you already have multiple reviews in history, look at
them too". Autonomous for the rest of the sprint; no per-row confirmation.

**2026-09-06** — `cliContainerBin` is not indirection without a difference: the CLI's
`resolveAppbayHome` consults `utils/system-config.ts` before core's four tiers, so the
wrapper passes a home core cannot derive. The comment was stale, the wrapper is not.

**2026-09-06** — Reviews are run by fresh subagents (at most three at once), one per
region, each handed the S1–S13 / Q1–Q7 rubric and told to read bodies; every finding is
verified in the main session against the file before it is fixed or dismissed.

# 2 · Design

## Restart

`down.ts` gains `stopApps(appbayHome, names)`: discover, order in reverse of `deployOrder`,
`compose down` each, return `{stopped, failures}`. `restart` calls it, then `deploy()` with
the same targets and prints through `printDeployReport`. Two commands, one stop path, one
start path.

## CLI spawns

`runtime/container-runtime.ts` already has `containerExec(args, options)` whose options are
`SpawnSyncOptions`, so `stdio: "inherit"` passes through. It gains `containerSpawn(args,
options)` for the two long-running cases (`logs -f`, the tunnel). The CLI sites replace
`spawnSync(cliContainerBin(), …)` with `containerExec(…, { appbayHome, stdio: "inherit" })`.
The arch rule "only runtime/ spawns a process" extends its scope to `apps/cli/src` with the
host-tool files listed as exempt.

## Review rounds

```
round n:
  three reviewers, regions: (A) services/deploy, deploy-service, observe, boot-order
                            (B) apps/cli commands that reach deploy or the runtime
                            (C) the diff of S47 + S48 so far
  each returns findings in the 03-CODE_QUALITY format
  main session verifies each against the file, fixes or dismisses with a reason, commits
  round n+1 until a round returns nothing above LOW
```

# 3 · Tasks

- [x] 1.1 `down.ts` `stopApps`; `restart.ts` through it and `deploy()` (row 40)
- [x] 1.2 journeys `WORKDIR` (row 42); apply-success and lifecycle on both guests run under 3.1
- [x] 1.3 row 12 residue
- [x] 1.4 `CompileOptions.appbayHome` (F13)
- [x] 1.5 KeePass env once
- [x] 1.6 `fetch` health wait; `checkGpu` unknown
- [x] 1.7 CLI container spawns through `runtime/`; arch rule scope widened
- [x] 1.8 `docker.ts` comment
- [x] 1.9 knip's unused exported types
- [ ] 2.1 review round 1, fixes
- [ ] 2.2 review round 2, fixes; further rounds until clean
- [ ] 3.1 journeys on both guests; ledger; pillars current state; S49 drafted; close

## Log

**2026-09-06** — created. Baseline after S47: core 1126, CLI 385, tsc clean, `check:*`
green, knip: 12 unused exported types and one unused docs file.

**2026-09-06** — 1.1–1.9 landed in 127fc05. Also found while converting setup.ts: its
Traefik scaffold writes three files through `bash -c "cat > <path> << 'EOF' …"` with the
path interpolated (ledger row 43); held for the round-1 reviewer of that region and fixed
after.
