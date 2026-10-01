---
spec: SPEC-014
title: A shared service layer — a stock compose's bundled database replaced by a provided one
status: proposed
tier: OSS
repo: appbay-cli
priority: after SPEC-012 — it needs the trait/compiler seam, and it is the first real consumer of it
---
# SPEC-014 — Shared service layer

## Requirement

An app whose upstream compose ships its own database (or cache, or queue) can run against a
**shared, separately deployed service layer** instead, without editing the upstream compose
and without the operator hand-rolling an override. The bundled service is dropped, the app is
wired to the shared one, and the connection values come from the deployment's namespace, not
from a file someone edits by hand.

Two halves, and only one of them exists today:

- **The rewrite half — exists.** `upstream.services.exclude` removes a service from the
  ingested compose (`docs/reference/appbay-yaml.qmd`), `overrides` deep-merges per service,
  and `overlays[].when` activates a fragment when a peer app is in the same namespace. That
  is enough to delete a bundled `db` and repoint the app at another service.
- **The value half — missing.** A peer can be *detected* (`when:`) but cannot *provide*
  anything. `${{ns:KEY}}` resolves only from `etc/namespaces/<ns>.yaml`
  (`docs/reference/scope-model.qmd`), which a human or `appbay init` writes. Nothing lets one
  app publish `PG_HOST` / `PG_PASSWORD` into the namespace so a peer can consume it.

This spec proposes the missing half: a **provider contract**, so an app can publish typed
connection values that peers in the same namespace consume. It is the appbay counterpart of
Score's resource outputs and Crossplane's connection details, kept in the shape appbay
already uses.

## Design, on existing seams

**`provides:` on the provider app.** A new optional block in `appbay.yaml`:

```yaml
# apps/postgres-lab/appbay.yaml — the shared service layer
namespace: lab.data
provides:
  postgres:
    service: db                      # the compose service that accepts connections
    host_key: PG_HOST                # keys written into the namespace scope
    port_key: PG_PORT
    user_key: PG_USER
    password_key: PG_PASSWORD        # value may be ${{ns:...}} or generated per deploy
    database_key: PG_DATABASE
traits:
  - type: backup
    schedule: "0 3 * * *"
    retention: 14
```

`provides.*` entries are compiled into namespace values at deploy time, the same file
`${{ns:KEY}}` already reads. The provider owns the secret material (`password_key`), so the
consumer never sees a credential in its own manifest — it sees a reference.

**Consumption stays conditional.** The consumer's overlay fires only when the provider app is
in the namespace, so an app with no provider keeps its bundled database untouched:

```yaml
# apps/n8n/appbay.yaml
namespace: lab.data
upstream:
  source: n8n-upstream/docker-compose.yml
  services:
    exclude: [db]                    # the bundled Postgres is dropped
overrides:
  n8n:
    depends_on: []                   # nothing left to depend on
overlays:
  - when: [postgres-lab]
    services:
      n8n:
        environment:
          - DB_TYPE=postgresdb
          - DB_POSTGRESDB_HOST=${{ns:PG_HOST}}
          - DB_POSTGRESDB_PORT=${{ns:PG_PORT}}
          - DB_POSTGRESDB_DATABASE=${{ns:PG_DATABASE}}
          - DB_POSTGRESDB_USER=${{ns:PG_USER}}
          - DB_POSTGRESDB_PASSWORD=${{ns:PG_PASSWORD}}
```

**Compiler hooks.** This lands in SPEC-012's `CompilerContext.hooks`: a provider resolves its
`provides` block in `beforeTraits` (so `${{ns:KEY}}` from the provider is visible to every
app's overlays), and a consumer's `exclude`/`overrides` are applied by the existing upstream
ingest. With SPEC-012, a shared-service *kind* can live outside core; without it, this is a
core feature.

**Not a Compose `network_mode` trick.** The provider and consumer stay separate compose
projects joined on `shared_network` (aliases `<ns>_<app>_<service>`, already implemented);
this spec adds no new networking.

## What it must not break

- Apps with no provider compile identically — bundle included, byte-for-byte on the fixture set.
- `upstream.services.exclude` keeps its current meaning; `overrides` keeps its current merge.
- `${{ns:KEY}}` resolution order is unchanged; `provides` writes into the same scope and is
  overridable by `<ns>.yaml`, not a second lookup path.
- The test suite stays green and no compile cost is added when no `provides:` is present.

## Open questions

1. **Where does a generated password live?** In the namespace values file (visible on disk) or
   in a secret store the secrets trait already talks to? The backup trait assumes volumes;
   credentials need the same honesty.
2. **Cross-namespace providers.** `namespace` is flat and values are one level up; a
   *host-level* database shared by several namespaces needs a scope this spec does not add.
   `operator:` is already reserved for future multi-node placement
   (`docs/reference/appbay-yaml.qmd`) and may be where host-scoped providers belong.
3. **Migration.** Replacing a bundled DB with a provided one on a running app is a data move.
   The spec should say the compiler never silently changes the datastore, only the wiring.
