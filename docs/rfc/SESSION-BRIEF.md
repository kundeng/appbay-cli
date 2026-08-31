# Session brief — implementing RFC-001

Paste this into a fresh session working on `appbay-cli`. Self-contained; assumes no prior context.

## What this is

`appbay-cli` has six areas that need consolidating: identity and passwords, the system home and
config hierarchy, secrets, a namespace axis, `when` semantics, and catalog sourcing.
[`RFC-001-consolidation.md`](RFC-001-consolidation.md) is the spec.
[`FINDINGS.md`](FINDINGS.md) is the measured basis for every decision in it, and
[`evidence/`](evidence/) holds the 17 probe records those findings cite.

**Read all three before writing code.** The RFC's decisions are not preferences — most of them
overturned a plausible first answer, and the finding says which and why.

## Repositories

| repo | remote | role |
|---|---|---|
| `appbay-cli` | `origin` → `github.com/kundeng/appbay-cli` | the code. `v0.0.1-alpha.11` / `bd32116` is what the RFC's line numbers refer to |
| `appbay-catalog` | `github.com/kundeng/appbay-catalog` | 150 app manifests. §3.7 and §6 touch it |
| `appbay` | `github.com/kundeng/appbay` | ⚠️ a **stale** private fork — `v0.0.1-alpha.4`, last commit 2026-08-09, seven releases behind. Reconcile or retire it; do not treat it as current |

**Test fixtures** — the UOM stack that exercises this — live on the branch
`pre-appbay-removal` of `github.com/kundeng/llm-stack`: `provision-appbay.yml` (the full
provisioning path), `catalog/` (five app manifests), `verify-payload.yml` and `verify-stack.yml`
(the acceptance tests). Clone that branch; do not read the Dropbox working copy, which is a
synced tree whose git history has diverged from its remotes before.

## Build and run

```
pnpm install --frozen-lockfile
pnpm -r --filter @appbay/core --filter @appbay/db build   # required before the CLI runs from source
APPBAY_HOME=$(mktemp -d) bun run apps/cli/src/index.ts <command>
```

`@appbay/core` and `@appbay/db` resolve through `main: dist/index.js`, so the CLI will not start
from source until both are built. Several findings were produced by importing
`packages/core/src/compiler/compile.ts` directly under `bun` against a `mktemp -d` home; that is
a cheap way to test compiler behaviour without a container runtime.

## Order

The RFC's Sequencing table is load-bearing, not advisory. Two dependencies in particular:

- **3.1 first.** Six sites put a secret in a `/bin/sh -c` argv, two of them the stored value.
  Nothing else ships before it.
- **4.1–4.2 second.** Collapsing `project` + `environment` into `namespace` is a text edit today
  because all 150 manifests read `default`/`default`. Once the tier is built it becomes a data
  migration.
- **§5 before 4.3.** `5.1` deletes the function `4.3` would fix.

## Things that will mislead you

- **`compile()`'s `project` and `environment` arguments are unreachable.** `compile.ts:380-381`
  reads `config?.x ?? defaultX` against fields declared `z.string().default("default")`, which
  are never `undefined` after parsing. Any flag you add is silently ignored until that changes.
- **A scope typo fails safe but silently at the reference.** `${{env.X}}` is an unknown scope; the
  literal survives the render and `deploy-service.ts:707-715` then refuses to deploy the app. You
  get a failed app, not a broken vhost — but no error names the typo directly.
- **`renderEdgeSecurityBlock` and `edgeSecretEnvMapping` look implemented and have zero callers.**
  So does the whole `etc/projects/<name>/` config tier: `ProjectConfigSchema` and
  `EnvironmentConfigSchema` have no non-test consumers, and the string `"projects"` is never
  joined into a path.
- **`docs/guide/*.qmd` describes intent, not always behaviour.** Verify against the code.

## How to work

- Follow `work-discipline` and `audited-ops`. Record load-bearing probes; fill verdicts as you go.
- This is a multi-part request: list deliverables, order, and out-of-scope, get approval, then
  write into the repo.
- Run it before claiming it works. Most of the corrections in the RFC's notice exist because a
  claim that read as obvious was tested and failed.
- Each landed group gets a release tag. The consuming project pins `appbay_release_tag`
  deliberately and re-converges on a named tag; do not expect it to track `main`.

## Out of scope

The Ansible-native deployment path for the UOM stack. That is a separate track on
`llm-stack@main`, deliberately not sharing a repo with this work. If you find something that
matters to it, write it down and hand it over.
