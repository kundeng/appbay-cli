# Structure

## Layout

```
packages/core/src/
  schemas/      appbay.yaml, instance config, state records — Zod, the only parsers
  compiler/     manifest + compose → rendered compose; identity.ts owns generated names
  traits/       the declarative capabilities the compiler applies
  state/        generated values that must survive a recompile
  runtime/      the container runtime adapter: which binary, which socket, how to ask it
  services/     use cases: deploy, install, migrate the edge, vault, config
  health/       doctor checks
  secrets/      secret providers and the deploy-time resolver
  shepherd/     one-shot helper containers run around a deploy
apps/cli/src/
  commands/     one file per command; argument parsing and printing only
  utils/        home resolution, formatting, the compose wrapper
scripts/journeys/   end-to-end runs against a Docker VM and a Podman VM
specs/              sprints, in order; the one marked ACTIVE is the head
docs/               steering, guides, reference, rfc, history
```

## Layers and the direction of dependency

```
apps/cli  ──▶  services, health  ──▶  compiler, traits, schemas, state
                    │
                    ▼
                 runtime  (the only code that spawns docker or podman)
```

The rule each layer owes:

| layer | owns | must not |
|---|---|---|
| `schemas` | every parse of a file or an env var into a typed value | be bypassed by a regex or an `as` cast on the same file |
| `compiler`, `traits`, `identity` | what a manifest means and every name the system generates | spawn a process |
| `runtime` | every `docker` or `podman` invocation for mutation, and every observation, which goes over the runtime's API socket and never parses CLI text | know what an app is |
| `services`, `health` | a use case end to end, reporting what it observed | parse runtime output or resolve the home directory itself |
| `apps/cli` | argv in, text out | hold a deploy, a doctor, or a parser of its own |

A fact has one reader. When a second reader appears, the first one moves to where
both can call it, and the second is deleted.

**Runtime differences live in the adapter, not in the core.** Docker and Podman differ in
flags, output shapes, socket paths and defaults. Those differences are data in
`runtime/` (a profile table) or a distinct adapter implementation. An `if` on the runtime
name inside `services`, `compiler` or `health` is the wrong shape, and a retry that papers
over a runtime difference is worse, because it hides which runtime misbehaved. Podman
support arrived after Docker; the layer that absorbs the difference is what keeps the
second runtime from spreading through the first one's code.

## Where truth lives

| kind | place |
|---|---|
| durable intent | `docs/steering/` |
| stable cross-cutting design | `docs/design/` |
| user and operator guides | `docs/guide/`, `docs/reference/` |
| dated evidence: reviews, ledgers, handoffs | `docs/history/` |
| sprints | `specs/` |
