---
spec_id: S43-one-scope-and-projects
status: CLOSED
closed_as: SHIPPED
since: 2026-09-05
until: null
epic: platform
features: [ns-scope, project-composition-unit, projects-file, namespace-flag]
supersedes: []
superseded_by: null
depends_on: [S42-crash-detection]
anchors: [data-architecture]
---

# S43: one value scope, and a project is what runs together

# 1 · Requirements

## Introduction

Kun's correction of S40, 2026-09-05: four scopes (`project`, `namespace`, `app`, `service`)
was too many and confused two things. **System** is physical: this box, this installation,
`etc/system.yaml`; no manifest interpolates it. **Project** is intent: the apps a human
operator runs together to do something. **Namespace** is one deployment of a project: identity
in every generated name, and the only value scope above a service, the way a Kubernetes
namespace is. Collections and tags are labels. The scope separator is a colon, and `when:` asks
whether the peer is declared in the same project, not the same collection.

## Mental Model & Invariants

- `${{ns:KEY}}` is the one reference. It reads `etc/namespaces/<ns>.yaml` layered over
  `etc/namespaces/default.yaml`; `appbay init` seeds `default.yaml` with `DOMAIN`.
- `project: <name>` in a manifest (default `default`) is the unit of composition: an overlay's
  `when:` sees peers in the same project; `etc/projects.yaml` orders projects with `after:`.
- `--namespace <ns>` on `up`, `compile` and `apply` puts every app that pins no namespace into
  that namespace for the run.
- `${{project.KEY}}`, the pre-S43 spelling, resolves as `${{ns:KEY}}` with a warning for one
  release; every other spelling, and every other scope, is a compile error naming `ns:`.

## Requirements

1.1 THE resolver SHALL accept `${{ns:KEY}}` (aliases `namespace:`) and nothing else, except the
    dotted `project.` alias which SHALL warn.
1.2 THE compiler SHALL build per-app values as `default.yaml` under `<ns>.yaml`; the install's
    domain SHALL come from the resolved `DOMAIN`.
2.1 THE manifest SHALL carry `project:` (single, default `default`); `collection` and `tags`
    SHALL stay labels; overlay peers SHALL be the apps of the same project.
2.2 `etc/projects.yaml` (`projects: {name: {after}}`, `readiness.timeout_seconds`) SHALL
    replace `collections.yaml`; `deployOrder` SHALL take projects.
3.1 `up`, `compile`, `apply` SHALL take `--namespace`; `init` SHALL seed
    `etc/namespaces/default.yaml`.
4.1 The catalog's system apps SHALL write `${{ns:DOMAIN}}`; the product page, scope model,
    concepts, traits, apps, secrets and manifest reference SHALL describe one scope.

## Out of Scope
- Removing the dotted `project.` alias (next release).
- Tags as a selector (labels only; no command reads them yet).

# 2 · Design

`ScopeResolver` takes `ScopeValues { ns }`; the pattern is `${{(\w+)([:.])(\w+)}}` and the
separator is checked per spelling. `compile()` computes `projectOf(app)` and `peersOf` from it;
`namespaceValuesFor(ns)` layers the two files. `schemas/projects.ts` is `collections.ts`
renamed with `projects:` as the key. `boot-order.deployOrder(apps, projects)` orders by
`project`. `compileInstall` and `deploy()` carry `namespace` through.

# 3 · Tasks

- [x] 1.1, 1.2 `scope-resolver.ts`, `compile.ts` (values layering, warnings surfaced)
- [x] 2.1 `schemas/appbay-yaml.ts` `project:`; `overlay-engine.ts` peers by project
- [x] 2.2 `schemas/projects.ts`, `boot-order.ts`, `deploy-service.ts`, `down.ts`
- [x] 3.1 `--namespace` on up/compile/apply; `init` seeds `etc/namespaces/default.yaml`
- [x] 4.1 system apps regenerated; docs rewritten (product.md, scope-model, concepts, traits, apps, secrets, overlays, appbay-yaml, README)
- [x] 5.1 tests: resolver, namespace-values (layering, alias warning, rejected spellings), overlay scoping by project, boot order by projects, readiness with projects.yaml, init seeds default.yaml
- [x] 5.2 live on the built binary against a scratch home (log)

## Log

**2026-09-05** — implemented in one pass from Kun's correction ("system is physical; project is
intent; `<scope>:` not dot; `when` is about project, collections and tags are labels").

**2026-09-05** — shipped. Proved with the built binary on a scratch home: `init` seeded
`etc/namespaces/default.yaml` with `DOMAIN`; with `etc/namespaces/uom.prod.yaml` (`DOMAIN`,
`TIER`) and `appbay compile echo --namespace uom.prod`, the render carried `TIER=prod`, the
dotted `${{project.DOMAIN}}` resolved with the one-release warning, and the route was
`uom-prod.echo.lab.example.org`; `appbay up traefik whoami echo --namespace uom.prod` with
`projects.yaml` ordering `demo` after `default` started traefik, whoami, echo in that order and
the whoami container was `appbay.uom-prod.whoami.whoami` with `com.appbay.namespace=uom.prod`.

The proof found two defects the suites had not: the `compile` command accepted `--namespace`
and never forwarded it (fixed, pinned by the scratch-home test), and the ingress trait built
its compose alias by hand as `<app>_<svc>` while the fragment dialled `<ns>_<app>_<svc>`, so a
namespaced app without `upstream:` was routed to a name nothing answered (fixed at the one
identity function, pinned by the same test). The larger gap behind the second, that identity
is produced only inside the upstream transform, is issue #10 and ledger row 27.
