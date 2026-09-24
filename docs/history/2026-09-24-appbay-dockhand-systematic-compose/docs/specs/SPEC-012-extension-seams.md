---
spec: SPEC-012
title: Extension seams, so the enterprise fork extends instead of amending
status: proposed
tier: OSS
repo: appbay-cli
priority: first — every enterprise spec depends on it
---
# SPEC-012 — Extension seams

## Requirement

A package outside `packages/core` can add traits, system apps, catalog source kinds and
compiler behaviour without modifying any base file, against a published `@appbay/core`.

## Design, on existing seams

**Traits.** `traits/registry.ts` gains `registerTrait(def: TraitDefinition)`. Anything
registered from outside carries `category: "extension"`, which makes the existing
`TraitCategory` union (`traits/types.ts:22`) real. Lookup falls through core to extension.
The `appbay.yaml` trait schema (`schemas/appbay-yaml.ts`) must accept a registered `type`:
extend the discriminated union at registration, or pass an unknown `type` through to the
registered definition's own Zod schema. Prefer the second; the union stays static.

**System apps.** `SYSTEM_APPS` (`system-apps.ts:27`) stops being a `const`.
`registerSystemApp(def: SystemAppDef)` and `listSystemApps()`; the twelve shipped apps
register themselves at import so nothing observable changes.

**Catalog kinds.** `schemas/catalog.ts:22` `type: z.enum(["git", "local"])` becomes a
registry of source kinds with one contract, `resolve(source) -> entries`. `git` and `local`
register themselves. `catalog-service.ts` dispatches through the registry.

**Compiler hooks.** `CompilerContext` (`traits/types.ts`) gains `hooks: { beforeTraits,
afterTraits, afterRender }`, each a list; `compile.ts` calls them at those three points and
does nothing when they are empty. This is the only change inside the compiler.

**Publish.** `packages/core/package.json`: `private: false`, semver from `0.1.0`, a
changelog. `apps/cli` keeps consuming by workspace; the fork consumes by version.

## What it must not break

Every existing trait, system app and catalog source behaves identically with no
registrations. `eject` output is byte-identical on the fixture set. The test suite stays
green. No measurable compile cost when nothing is registered.

## How to verify

A test package outside `packages/core` registers one trait, one system app, one catalog
kind and one hook; a fixture `appbay.yaml` uses all four and compiles. `grep -rn` for the
fork's package name in `appbay-cli` returns nothing.
