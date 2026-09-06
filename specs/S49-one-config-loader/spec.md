---
spec_id: S49-one-config-loader
status: DRAFT
closed_as: null
since: 2026-09-06
until: null
epic: config
features: [env-schema, print-config, eslint-strict]
supersedes: []
superseded_by: null
depends_on: [S48-review-green]
anchors: [data-architecture]
---

# S49: one reader for the environment, and a linter

# 1 · Requirements

The 2026-05 review's S13 finding, scheduled and not taken: 34 `process.env` reads sit
outside the three schematised readers (`runtime/home.ts`, `runtime/container-runtime.ts`,
`schemas/`). Each is a key nobody can list, print, or validate. The hygiene finding beside
it: no linter runs (`turbo lint` executes nothing).

## Mental model

- Every environment key the product reads is declared once, in one Zod schema in core,
  with its plane (devtime / deploy-time / runtime), its default, and one sentence on what it
  controls. Code reads the parsed object, never `process.env`.
- `appbay config print` shows the resolved values with their source (env, pointer file,
  default) and secrets masked. This is the EP1b provenance requirement.
- The CLI passes the home down; it does not write `APPBAY_HOME` into its own environment
  so that core's private resolvers agree (`cli/index.ts`, `init.ts:846`).
- eslint with the strict TypeScript preset runs in `turbo lint`; the first run's findings
  are fixed or each rule that is turned off carries a reason.

## Inventory (2026-09-06, `rg 'process\.env\.[A-Z_]+' -g '!*.test.ts'`)

| key | read at | plane |
|---|---|---|
| `APPBAY_CADDY_IMAGE` | services/edge-identity-service.ts:184 | deploy-time |
| `APPBAY_KEEPASS_DB`, `APPBAY_KEEPASS_KEYFILE` | secrets/providers/keepass.ts (one reader since S48) | deploy-time |
| `APPBAY_MASTER_PASSWORD` | secrets/master-password.ts:113, services/vault-service.ts:161,164 | secret reference (T1) |
| `APPBAY_VERSION` | core/index.ts:15 | build-time |
| `APPBAY_BIND` | cli/commands/server.ts:157 | deploy-time |
| `APPBAY_UPDATE_VERSION`, `APPBAY_UPDATE_URL`, `GITHUB_TOKEN`, `CI` | cli/commands/update.ts | devtime |
| `APPBAY_CATALOG_SOURCE` | cli/commands/init.ts:91,1043 | deploy-time |
| `APPBAY_CONTAINER_RUNTIME` (written) | cli/commands/init.ts:846 | deploy-time; the write goes |
| `APPBAY_ACME_DNS_RESOLVERS` | cli/commands/setup.ts:558 | deploy-time |
| `OLLAMA_HOST`, `APPBAY_OLLAMA_URL` | cli/commands/models.ts:21 | runtime |
| `USER` | cli/commands/init-system.ts:253 | host fact |
| `DOCKER_HOST`, `CONTAINER_HOST`, `XDG_RUNTIME_DIR`, `APPBAY_RUNTIME_SOCKET` | runtime/facts.ts:130, runtime/socket.ts:32-39 | already in runtime/, to join the schema |

## Requirements

1.1 A `runtime/env.ts` (name open) SHALL declare every key above in one Zod schema and
    export the parsed object; no other file SHALL read `process.env` except the schema, and
    the arch rule SHALL enforce it.
1.2 `appbay config print` SHALL list each key, its value or `***`, and its source.
1.3 THE CLI SHALL stop writing `APPBAY_HOME` and `APPBAY_CONTAINER_RUNTIME` into its own
    environment; the home reaches core as an argument.
1.4 `turbo lint` SHALL run eslint with `typescript-eslint` strict; CI SHALL fail on a
    finding.

# 2 · Design

Written when the sprint is planned. The schema lives beside `home.ts`; the CLI keys that are
devtime only (`update`) may stay CLI-side behind the same schema type.

# 3 · Tasks

- [ ] 1.1 the schema and the arch rule
- [ ] 1.2 `config print`
- [ ] 1.3 the two env writes removed
- [ ] 1.4 eslint; first-run findings fixed or justified

## Log

**2026-09-06** — drafted at the close of S48 to carry the S13 and hygiene findings from the
2026-09-06 review.
