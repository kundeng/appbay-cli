---
spec: SPEC-003
title: The default edge must support the default trait set
closes: F6
status: proposed
priority: 3 — high value, low risk
---

# SPEC-003 — The default edge must support the default trait set

## Requirement

An operator who accepts every default must be able to use every core trait. Either the
default `ingress_provider` supports `auth`, or declaring `auth` on a Traefik install must
fail at a moment and in a manner the operator can act on before deploying anything.

## Why

`DEFAULT_INGRESS_PROVIDER` is `"traefik"` (`packages/core/src/schemas/instance.ts:72`);
`auth.ts:77` errors unless the provider is `caddy`. So a default install cannot use the
headline access-control trait, and the failure arrives at compile time — after the operator
has written the manifest ([F6](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f6)).
This is not a bug in either piece; it is a default that contradicts the product's own
documentation, which leads with authenticated access.

## Design, on existing seams

**Recommended: change the default to `caddy`.** The constant is single-sourced and already
imported by exactly three call sites (`container-runtime.ts:117`, `init.ts:620`,
`init.ts:661`). The supporting machinery is built and tested: `edge migrate` already
switches providers with validation and rollback, `edge-migration-service.ts` handles the
port handover, and `caddy-edge-contract.test.ts` pins the contract. Caddy is the only
provider that can satisfy the full trait set, so it is the only defensible default.

Guard rails this needs:
- `DEFAULT_INGRESS_PROVIDER` changes value; `resolveIngressProvider`'s *absent* case then
  means Caddy. Existing installs are unaffected only if they wrote the key. `appbay init`
  writes `ingress_provider` only when it differs from the default (`init.ts:620`), so
  installs created on the old default have **no key** and would silently change edge on
  upgrade. That is the one real hazard here, and it must be closed by writing the key
  explicitly on every `init` from now on, plus a one-shot migration that pins `traefik`
  into `etc/system.yaml` for any home whose `var/lib/renders` already contains
  `etc/apps/traefik/config/dynamic/` artifacts.

**Alternative, if the default must stay Traefik:** move the check from the trait to
validation. `apps/cli/src/commands/validate.ts` and the trait registry's conflict machinery
(`traits/registry.ts`, `ConflictPolicySchema`) are the seam — an `auth`-on-Traefik
combination is exactly a declared conflict, and reporting it from `appbay validate` puts it
before the operator at authoring time rather than at compile time.

## What it must not break

- **Traefik must remain a supported ingress.** `docs/deploy/production.qmd` documents it as
  an ingress-only mode; this changes the default, not the support matrix.
- **`edge migrate` rollback.** The migration path restores the old edge on any failure; the
  default change must not let a half-migrated install exist.
- **Installs with no `ingress_provider` key.** See the hazard above — this is the only way
  the change can hurt someone, and it is the part to test hardest.
- **The Traefik emitter and `buildTraefikConfig` stay.** `ingress.ts:336` is deliberately
  the single branch point on provider; keep it that way.

## How to verify

1. Re-run NP4 (`src/appbay-dockhand/compile_untouched_compose.sh`) with the provider key
   removed from `etc/system.yaml`: the compile must now succeed and emit the Caddy policy.
2. A test that every core trait compiles clean against the default provider — the general
   form of the defect, so it cannot come back with a different trait.
3. Upgrade simulation: a home with Traefik artifacts and no `ingress_provider` key must
   still resolve to Traefik after the change.
