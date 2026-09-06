---
spec_id: S44-identity-for-every-app
status: CLOSED
closed_as: SHIPPED
since: 2026-09-05
until: null
epic: correctness
features: [identity-unconditional]
supersedes: []
superseded_by: null
depends_on: [S43-one-scope-and-projects]
anchors: [data-architecture]
---

# S44: identity is a pass every app goes through

# 1 · Requirements

## Introduction

Issue #10, found by S43's live proof. The container name, the `com.appbay.*` labels and the
shared-network alias were produced only inside `transformUpstream`, which `compile()` ran only
for a manifest with an `upstream:` block. A plain app (a compose file and a manifest with just
traits) deployed as `<app>-<svc>-1` with no labels: `appbay ps` saw it through the compose
project, but nothing that asks by label could, and a namespaced one was not namespaced in its
name. The product page says identity comes from the compiler, not the manifest.

## Requirements

1.1 EVERY service of every app SHALL carry `container_name` from `identity.containerName`
    and the `com.appbay.app` / `com.appbay.namespace` labels, with or without `upstream:`.
1.2 THERE SHALL be one producer of that identity; the upstream transform SHALL call it.
2.1 A compile test SHALL pin a namespaced app without `upstream:`; the scratch-home test SHALL
    pin the deployed name.

# 2 · Design

`withIdentity(service, ns, app, svc)` in `upstream-transform.ts` is the one producer;
`transformUpstream` uses it per service, and `applyIdentity(compose, ns, app)` maps it over a
compose model that had no upstream block. `compile()` Stage 2a takes the second branch when
`config.upstream` is absent. Networks, volumes and path rewriting stay upstream-only: a plain
compose file is taken as written apart from its identity.

# 3 · Tasks

- [x] 1.1, 1.2 `withIdentity` / `applyIdentity`; Stage 2a else-branch
- [x] 2.1 `namespace-values.test.ts` (identity without upstream); scratch-home test pins `appbay.lab.echo.echo`
- [x] 3.1 live: `up traefik echo --namespace lab` on Docker; the container is `appbay.lab.echo.echo` with `com.appbay.app=echo`, `com.appbay.namespace=lab`; Traefik's API reports `http://lab_echo_echo:80` UP and the alias answers from the edge container and from a third container on `appbay_shared`

## Log

**2026-09-05** — shipped. The HTTPS path through the edge was not exercised: on a `.local`
domain the ACME resolver has no certificate and the edge answers "unrecognized name" for the
whoami system app too, so that is the environment, not this change.
