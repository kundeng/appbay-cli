---
spec: SPEC-001
title: One environment model across the compiler
closes: F3, F4
status: proposed
priority: 1 — highest value, lowest risk
---

# SPEC-001 — One environment model across the compiler

## Requirement

Every compiler stage that reads or writes a service's `environment:` must treat the list
form (`["K=v"]`) and the map form (`{K: v}`) as the same thing. No stage may discard an
entry it did not put there, and no stage may silently decline to act on a form it does not
recognise.

Concretely, after this change the two services in
[probe-05](../../raw/probe-05-map-form-environment-is-handled-three-ways.yaml) — identical
but for how `environment:` is spelled — must render identical environments.

## Why this one first

It is the only finding in this investigation that destroys operator data. It is also the
cheapest to fix: CodeGraph puts four callers on `scopedEnvTraitDefinition`, two of them
tests and two barrel re-exports ([F4](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f4)),
so nothing outside the trait depends on the current behaviour.

## Design, on existing seams

The seam is the trait system's own `TraitTransformInput.compose` contract. Three sites
currently each carry their own opinion:

| site | today | after |
|---|---|---|
| `packages/core/src/compiler/compile.ts:1019` (`resolveMagicVars`) | `if (!Array.isArray(svc.environment)) continue` | normalise, resolve, denormalise |
| `packages/core/src/traits/definitions/scoped-env.ts:34` | `Array.isArray(env) ? env : []` — destroys the map | normalise, append, denormalise |
| `packages/core/src/traits/definitions/secrets.ts:56` | handles array, object and absent | unchanged in behaviour; reuse the helper |

Add one module, `packages/core/src/compiler/service-env.ts`, with the whole opinion in it:

```ts
/** The two spellings Compose accepts for `environment:`, and which one a service used. */
export type EnvForm = "list" | "map" | "absent";

/** Read a service's environment as ordered pairs, remembering the form it was written in. */
export function readServiceEnv(svc: Record<string, unknown>):
  { form: EnvForm; entries: Array<[string, string]> };

/** Write pairs back in the form the service used, so the render stays close to the input. */
export function writeServiceEnv(
  svc: Record<string, unknown>, form: EnvForm, entries: Array<[string, string]>,
): void;
```

Round-tripping through the *original* form is deliberate: an operator reading
`docker-compose.rendered.yml` beside their own file should see their own spelling. A
normalise-everything-to-a-list approach would work but makes every map-form app's render
gratuitously unrecognisable, and the render is the artifact operators diff.

`absent` stays distinct from an empty map because `secrets.ts:120` already branches on it
to create an environment block that did not exist.

Both traits and `resolveMagicVars` then become: read, transform pairs, write.

## What it must not break

- **List-form ordering.** `probe-05` shows appended vars land after existing ones;
  `scoped-env.test.ts` asserts `["EXISTING=keep-me", "NEW_VAR=new-value"]`. Preserve it.
- **Entries with no `=`.** `compile.ts:1021` passes through entries where `eq <= 0`
  (Compose's "inherit from the host environment" form, `- SOME_VAR`). `readServiceEnv`
  must represent these — pair with an explicit sentinel rather than `""`, which would
  render `SOME_VAR=` and change the meaning from *inherit* to *set empty*.
- **The secrets trait's three cases.** Case 1 (key matches a ref), case 2 (`${REF}` appears
  in a value), case 3 (ref absent, append) must behave identically for both forms — they
  already do, so this is a regression guard, not new behaviour.
- **`structuredClone` discipline.** Both traits clone before mutating. The helper must not
  alias the caller's object.
- **`${VAR}` and `${VAR:-default}` are Compose's, not AppBay's.** `parseMagicVar` must keep
  declining them. `nextcloud` and `homeassistant` are full of `${X:-default}`.

## How to verify

1. **Invert the test that locks the bug in.** `scoped-env.test.ts:178`, currently
   *"treats object-form environment as empty array (does not merge)"*, becomes
   *"merges into an object-form environment, preserving its entries"* and asserts
   `{EXISTING: "old-value", NEW_VAR: "new-value"}`. Leaving it and adding a second test
   would leave the suite asserting both behaviours.
2. **A form-equivalence property test.** For a generated service environment, assert that
   compiling the list spelling and the map spelling yields the same set of key/value pairs
   after every trait. `packages/core/src/compiler/__tests__/properties.test.ts` already
   hosts property tests.
3. **Re-run NP5 unchanged.** `src/appbay-dockhand/map_form_environment.sh` is the acceptance
   test: `listform` and `mapform` must render equal environments and the generated-values
   store must hold two entries, not one.
4. **Compile the four map-form system apps** (`nextcloud`, `jellyfin`, `homeassistant`,
   `sysinfo`) before and after; the renders must differ only where a trait legitimately
   added something.
