# Data architecture

The stores an install holds, who writes each, which is source of truth, and how each is
read back. Every spec that touches one of these anchors here. A schema says what fields
exist; this page says what a field means across a recompile, a redeploy, and a copy of the
home to another machine.

## Tiers

```
manifest tier      etc/apps/<app>/appbay.yaml + docker-compose.yml   (declared by the operator or the catalog)
      │  compile()
      ▼
render tier        var/lib/renders/<app>/docker-compose.rendered.yml + .env   (derived; what compose runs)
      │  compose up -d
      ▼
runtime tier       containers, networks, volumes                     (owned by docker/podman; observed, never written directly)
```

Two stores sit beside the tiers and feed the compiler: the instance config
(`etc/system.yaml`) and the generated values (`var/lib/state/generated-values.yaml`).
Secrets are a fourth, read at deploy time and never rendered to disk in the clear.

Contract at each boundary:

| boundary | what crosses | direction | shape |
|---|---|---|---|
| manifest → compile | `AppbayYamlSchema`-parsed manifest, upstream compose as a parsed document | down | typed; the only legal parse is the Zod schema |
| instance config → compile | `domain`, `ingress_provider`, `container_runtime`, `container_store`, `home` | down | `InstanceConfigSchema`; one loader |
| generated values → compile | `(namespace, service, key) → value` | both: compile reads, and writes a new key on first use | `GeneratedValueStore` |
| compile → render | one compose document per app; the app's edge route files are held in the compile output and written by the deploy's route link once the app's container is up and the edge is seen running | down | files; the render is derived and disposable |
| render → runtime | `compose -f <render> up -d` | down | the compose binary owns naming and recreate semantics |
| runtime → services | container state | up | typed rows from one adapter (`runtime/observe.ts`) over the Engine API socket; no CLI text is parsed |

## Lifecycle table

| store | path | writer | immutable or rolling | source of truth or derived | read path | retention | reproducible |
|---|---|---|---|---|---|---|---|
| instance config | `etc/system.yaml` (legacy `project.yaml`) | `appbay init`, `upsertInstanceKey` | rolling | source of truth for domain, provider, runtime, store, recorded home | `readInstanceConfigText` + `InstanceConfigSchema`; must not be regex-scraped | life of the install | no; it is the operator's choice |
| manifest | `etc/apps/<app>/appbay.yaml` | operator, `appbay install`, `appbay config` | rolling | source of truth for what the app is | `AppbayYamlSchema` | life of the app | no |
| upstream compose | `etc/apps/<app>/docker-compose.yml` | catalog or operator | rolling | source of truth for the app's services | parsed YAML, object-checked; no compose schema | life of the app | no |
| app env | `etc/apps/<app>/.env`, `.env.local` | operator, `install` (values) | rolling | source of truth for per-app values; `.env.local` holds secrets and is mode 0600 | `parseEnvFile`; compose reads them as `env_file` | life of the app | no |
| render | `var/lib/renders/<app>/` | `compile()` | rolling, overwritten each compile | derived | read by `compose -f` and by `ps`; never edited | until next compile | yes, from manifest + instance config + generated values + runtime facts |
| generated values | `var/lib/state/generated-values.yaml` | `compile()` on first use of a `generate:` var | append-mostly | source of truth for values that must survive a recompile (passwords the app already stored) | `GeneratedValueStore` | life of the install; losing it re-keys every generated secret | no, by design |
| runtime facts | `var/lib/state/` (facts cache) | `detectRuntimeFacts` | rolling | derived from the host | read by `compile()` | until re-detected | yes |
| vault | `vault.enc` / `secrets.kdbx` | `appbay secrets`, `appbay init` | rolling | source of truth for secret values | provider `get`; wrong password and absent key must be distinguishable | life of the install | no |
| saved home pointer | `~/.config/appbay/home`, `/etc/appbay/config` | `appbay init --dir` | rolling | source of truth for which home a CLI invocation means | `resolveAppbayHome` in the CLI; core must be handed the result, not re-derive it | life of the machine | no |
| containers, networks, volumes | the runtime | `compose up -d` and system apps | rolling | source of truth for what is running; nothing here is source of truth for what should run | one adapter function that returns typed rows or unknown | runtime-managed | yes, from the render |

## Invariants

1. A render is never edited by hand and never the source of a fact. Anything a reader wants
   from a render, the compiler can produce again.
2. Generated values are the one store a recompile must not regenerate. A copy of the home
   without `generated-values.yaml` is a different install.
3. The runtime is observed, never trusted from a prior step. "The last command exited 0" is
   not a read of this store.
4. One loader per file. A second parser of `system.yaml`, `appbay.yaml`, or `.env` is a defect.
5. A secret value appears in exactly two places: its vault and the process environment of
   the compose child for the duration of `up`. Not argv, not a render, not a log.

## Storage choice

Flat files under one directory, because the install must be copyable, diffable, and
readable by an operator with `cat`. The one binary-ish store is the vault, whose format
is the secret provider's. No database; the web control plane keeps its own in `packages/db`
and it is not source of truth for anything in this table.
