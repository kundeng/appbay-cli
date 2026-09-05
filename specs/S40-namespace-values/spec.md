---
spec_id: S40-namespace-values
status: ACTIVE
closed_as: null
since: 2026-09-05
until: null
epic: platform
features: [namespace-values, app-scope, default-ingress-host, duplicate-host-check]
supersedes: []
superseded_by: null
depends_on: [S39-collection-boot-order]
anchors: [data-architecture]
---

# S40: a namespace carries values, and identity produces the host

# 1 · Requirements

## Introduction

Kun's definition (docs/steering/product.md): a namespace is identity and a value store, the
way `project.yaml` and `environment.yaml` once meant to be. RFC-001 §4 opened for two
instances of one app in one home; identity was done in S32 and the hostname, the one field
measured as colliding (F49), stayed a manifest literal. This sprint closes both: values per
namespace, a computed app scope, a default host from identity, and a compile error when two
apps resolve one host. Reverses S32's rejection of RFC-001 4.6 (ledger row 21).

## Mental Model & Invariants

- `${{project.KEY}}` is per host; `${{namespace.KEY}}` is per deployment, from
  `etc/namespaces/<ns>.yaml`; `${{app.KEY}}` is what the compiler knows; `service` is reserved.
- An ingress trait that omits `host:` is routed at `<stem>.<domain>`; two instances of one
  app therefore differ in host without either manifest saying so.
- Two apps resolving one host is a compile error naming both; nothing is deployed for either.
- The `environment` scope is gone. It resolved against an empty map since RFC-001.

## Requirements

1.1 THE resolver's scopes SHALL be `project`, `namespace`, `app`, `service`.
1.2 `${{namespace.KEY}}` SHALL resolve from `etc/namespaces/<namespace>.yaml` for the app's
    namespace (`default.yaml` when un-namespaced); a missing file is an empty scope.
1.3 `${{app.KEY}}` SHALL carry `NAME`, `NAMESPACE`, `STEM`, and `HOST` when a domain exists.
2.1 WHEN an ingress trait omits `host:`, THE route SHALL be at `defaultHost(ns, app, domain)`;
    with no domain either, the trait SHALL error naming the two ways to fix it.
2.2 THE auth trait SHALL derive the same default when its sibling ingress omits `host:`.
3.1 WHEN two apps in a compile resolve the same host, THE compiler SHALL emit an `ingress`
    error for each, naming all of them.
4.1 The scope model reference, the concepts guide, the manifest reference and the README SHALL
    describe the four scopes and the default host.

## Out of Scope
- Migrating the 107 catalog manifests to omit `host:` (they already write the derived value).

# 2 · Design

`schemas/namespace-values.ts` loads the flat file. `compile()` takes `namespacesDir` (from
`compileInstall`) or `namespaceValues` (tests) and builds one `ScopeResolver` per app with the
four scopes. `identity.defaultHost` is `<auxFileStem>.<domain>`; the ingress trait fills
`host` from it and records `ingressHost:<service>` in trait metadata; `compile()` groups those
after Stage 2 and errors on any host with two owners. `CompilerContext.domain` carries the
install's domain to traits.

# 3 · Tasks

- [x] 1.1 scopes; 1.2 loader; 1.3 app scope — `scope-resolver.ts`, `schemas/namespace-values.ts`, `compile.ts`
- [x] 2.1 default host in identity and the ingress trait; 2.2 auth follows
- [x] 3.1 duplicate-host compile error
- [x] 4.1 docs: scope-model.qmd, concepts.qmd, appbay-yaml.qmd, README
- [x] 5.1 tests: `namespace-values.test.ts` (values file, default scope, app scope, default host on both namespaces, two instances, duplicate host, no domain); scope tests moved from `environment` to `namespace`

## Log

**2026-09-05** — implemented in one pass after S39, from the review's row-10 proposal and
Kun's row-21 decision.
