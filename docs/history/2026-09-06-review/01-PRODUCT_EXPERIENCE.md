# Product experience — 2026-09-06

What an operator can do with appbay-cli today, by product area, with the status of each
capability as measured in this review: ✅ verified this session, ⚠ partial, ❌ broken with
evidence, 🔬 never demonstrated. Anchors are `[src:path:Ln]` for code read in this review and
`[spec:]` for the sprint that shipped the behaviour. Nothing here is copied from an earlier
review.

## Core experience

An operator installs one binary, runs `appbay init`, installs an app from the catalog, and
runs `appbay up <app>`. The CLI compiles the app's `appbay.yaml` and upstream compose into the
compose file that runs, starts it, installs its route on the edge, and reports what it
observed. Docker and Podman are both supported; the choice is made at init.

```
install.sh ─▶ init ─▶ (install) ─▶ up ─▶ https://<app>.<domain>
                │                    │
             doctor              ps / status / logs
```

## 1 · Install and bootstrap

<details><summary>Mental model</summary>

A **home** (`APPBAY_HOME`) is one installation: `etc/` holds what the operator declared,
`var/` what appbay derived. `init` scaffolds it; `init-system` is the RHEL-family bootstrap
that installs the runtime and creates the service account before `init` runs. `doctor` is
three-valued: a check that could not look says unknown, and the JSON `ok` is false over any
required check that is not ok `[src:packages/core/src/health/checks.ts:1121]`.
</details>

| capability | status | evidence |
|---|---|---|
| `curl \| sh` install | 🔬 | `scripts/install.sh` exists; not run this session |
| `appbay init` scaffolds a home, seeds system apps, writes `etc/system.yaml` and `etc/namespaces/default.yaml` | ✅ | scratch homes on Docker and both Lima guests; `[src:apps/cli/src/commands/init.ts:958-1010]` |
| `appbay init-system` on RHEL-family with Docker: repo, packages, service account, ACLs, unit | ✅ | Rocky 9.8 guest, `[spec:S45]` 6.2 |
| `appbay init-system` with Podman | ✅ | `[spec:S34]` (earlier session), profile `[src:packages/core/src/runtime/container-runtime.ts:281-290]` |
| `appbay doctor` three-valued, `--json` never ok over a required unknown | ✅ | `[src:packages/core/src/health/checks.ts:1040-1043,1121-1133]`; scratch-home test |
| `appbay home` explains which tier chose the home | ✅ | one resolver `[src:apps/cli/src/utils/appbay-home.ts:132]` over core `runtime/home.ts` |
| `appbay update` self-update | 🔬 | not run; reads `APPBAY_UPDATE_*` env directly `[src:apps/cli/src/commands/update.ts:49-58]` |

Requires: a container runtime. Enables: everything below.

## 2 · Compile: manifest to compose

<details><summary>Mental model</summary>

`compile()` `[src:packages/core/src/compiler/compile.ts:193]` runs per app: discover →
upstream transform (identity, networks, volumes) or identity alone `[src:compile.ts:451-481]`
→ resolve `${{ns:KEY}}` → magic values → overlays → traits → builds → render → plan. **System**
is the box (`etc/system.yaml`); **project** is the composition unit (`project:` in the
manifest, what `when:` sees); **namespace** is one deployment and the only value scope,
`etc/namespaces/<ns>.yaml` over `default.yaml`. Collections and tags are labels.
</details>

| capability | status | evidence |
|---|---|---|
| identity: `appbay.[<ns>.]<app>.<svc>`, `com.appbay.*` labels, shared alias, for every app | ✅ | `[src:packages/core/src/compiler/upstream-transform.ts:103-140]`, `[spec:S44]` |
| one value scope `${{ns:KEY}}`, layered values, `--namespace` | ✅ | `[src:packages/core/src/compiler/scope-resolver.ts]`, `[spec:S43]`, live on three hosts |
| conditional overlays by project peers | ⚠ | selection ✅ `[src:packages/core/src/compiler/overlay-engine.ts:96]`; **two overlays on one service lose the first one's arrays** `[src:compile.ts:533-541]`, measured (F3) |
| traits: ingress, auth, gpu, hooks, secrets, scoped-env, backup | ⚠ | seven registered `[src:packages/core/src/schemas/appbay-yaml.ts]`; backup is metadata only and warns `[src:packages/core/src/services/deploy-service.ts:494-513]` (F8) |
| default ingress host from identity; duplicate host is a compile error | ✅ | `[spec:S40]`, `[src:packages/core/src/traits/definitions/ingress.ts:338-346]` |
| plan/diff, `apply --dry-run` | ✅ | `[src:apps/cli/src/commands/apply.ts]`; compiles twice per apply (F18) |
| builds (`build:` resolved to an image before deploy) | 🔬 | `[src:compile.ts:700-725]`; not exercised this session |
| generated values survive a recompile | ✅ | `[src:compile.ts:1004-1043]`, `state/generated-values.ts` |

## 3 · Deploy and observe

<details><summary>Mental model</summary>

`deploy()` `[src:packages/core/src/services/deploy-service.ts:438]` compiles, orders apps
(system apps first, then `etc/projects.yaml`), and for each app: writes the render, resolves
secrets into the compose child's environment, runs `compose up -d`, then **looks**: a crash
read at once and again after a grace, the route install, and a bounded readiness wait when
something depends on the app. Every look goes over the runtime's API socket through one
`Observer` `[src:packages/core/src/runtime/observe.ts:59]`; unknown is reported, never
counted as ok.
</details>

| capability | status | evidence |
|---|---|---|
| `up` reports deployed / unchanged / failed / started-but-unrouted from observation | ✅ | `[src:deploy-service.ts:680-725,795-835]`; s29 journey 10/10 on Podman `[spec:S45]` |
| crash detection incl. restart loops, second read after grace | ✅ | `[src:observe.ts:181-192]`, `[src:deploy-service.ts:541-549]`, `[spec:S42]` |
| readiness gating by project order | ⚠ | wait ✅ `[src:deploy-service.ts:838-857]`; **a one-shot init service never reads ready** `[src:observe.ts:225-229]` vs hooks `restart: "no"` `[src:traits/definitions/hooks.ts:121]` (F4); **five failure branches do not block dependents** `[src:deploy-service.ts:598-607,644-656,660-669,758-768,795-800]` (F2) |
| `ps`, `status`, `logs` | ✅ | `ps` over the observer `[src:apps/cli/src/commands/ps.ts:41]`; scratch-home tests |
| `down` in reverse project order | ✅ | `[spec:S43]`; `down.ts` uses `loadProjects` |
| an app that fails to compile is not started | ✅ | `[src:deploy-service.ts:570-607]` |

## 4 · Edge and routing

| capability | status | evidence |
|---|---|---|
| Traefik edge, route fragments per app, default host | ✅ | live HTTPS 200 on `appbay.local` on Docker and Podman `[spec:S45]` 2.1 |
| Caddy edge (`init --ingress-provider caddy`) | ✅ | Podman guest, whoami served `[spec:S45]` 6.1 |
| `edge migrate --to <provider>` with validation and rollback, outgoing edge observed | ✅ | both directions on Podman `[src:packages/core/src/services/edge-migration-service.ts:61-90]`, `[src:apps/cli/src/commands/edge.ts:106-120]` |
| auth trait (portal) | 🔬 | not exercised |
| ACME DNS-01 (`acme_dns_provider: cloudflare`) | 🔬 | schema `[src:packages/core/src/schemas/instance.ts:67]`; not exercised |
| edge on a multi-homed host | ❌ by design gap | one `DOMAIN` per namespace; ledger row 28 awaits a decision |

## 5 · Secrets

<details><summary>Mental model</summary>

A manifest references a secret by URI (`vault://app/KEY`, `keepass://`, `sops://`, `file://`,
`env://`). The vault is AES-256-GCM under a scrypt key with a per-vault salt
`[src:packages/core/src/secrets/providers/vault.ts:49-98]`, opened by one master password
resolved in one place `[src:packages/core/src/secrets/master-password.ts:110]`. At deploy the
trait's `injection:` decides how the value reaches the container.
</details>

| capability | status | evidence |
|---|---|---|
| vault set/get, KeePass, SOPS providers | ✅ (vault) 🔬 (others) | vault used on three hosts this session |
| `runtime-env`: value in the compose child's environment only, never argv or render | ✅ | `[src:packages/core/src/secrets/resolve-for-deploy.ts:123-160]`, `[src:apps/cli/src/utils/docker.ts:68-77]` |
| `wrapper-file`: files on a volume, no env | ✅ | Docker and Podman with padded values `[spec:S45]` 3.1 |
| `entrypoint-wrapper` | ⚠ | works with a hand-built injector on both runtimes; **nothing ships the injector** (issue #11, F11) |
| `wrapper-live` | ❌ | in the schema `[src:packages/core/src/schemas/appbay-yaml.ts:288]`, handled nowhere `[src:resolve-for-deploy.ts:140,212,294]`: the secret is silently absent (F1) |
| `none` | ✅ | declared and not injected, which is what it says |
| catalog install wires secrets into the vault | ⚠ | with the vault locked it **writes the value to `.env.local` in plaintext** `[src:packages/core/src/services/catalog-service.ts:230-247]` (F9, decision) |
| master password at rest | ⚠ | plaintext file, mode 0600, beside the vault `[src:master-password.ts:143-157]` (F10, decision) |

## 6 · Catalog and apps

| capability | status | evidence |
|---|---|---|
| `catalog list/get`, sources | 🔬 | `[src:packages/core/src/services/catalog-service.ts:40-107]` |
| `install <app> [--as name]` copies the entry, prompts inputs, writes `.env.local` | ⚠ | `[src:catalog-service.ts:108-306]`; **the vault key uses the catalog name, not the installed name**, so two `--as` installs share secrets `[src:catalog-service.ts:207,217]` (F5) |
| `config`, `env`, `presets`, `eject` | 🔬 | round-trip editor `[src:packages/core/src/services/config-service.ts]` |
| twelve system apps embedded, checked against `system-apps/` | ✅ | `check:system-apps` green |

## 7 · Control plane and service install

| capability | status | evidence |
|---|---|---|
| `server start` runs the web control plane container, waits for health | ✅ | Rocky guest: healthy, HTTP 200 `[spec:S45]` 6.2 |
| `appbay-server.service` survives a reboot | ✅ | Rocky guest reboot `[spec:S45]` 6.2 |
| `server status` when the socket is unreachable | ⚠ | unknown collapses to "not running" `[src:apps/cli/src/commands/server.ts:54-57]` (F7) |
| `rebuild-cache` regenerates the server's SQLite from disk | 🔬 | `[src:apps/cli/src/commands/rebuild-cache.ts]`, depends on `packages/db` |
| web UI, tRPC API | out of tree | documented in `docs/guide/web-ui.qmd`, `docs/reference/api-endpoints.qmd`; the code is a separate repository |

## 8 · Runtime portability

| capability | status | evidence |
|---|---|---|
| Docker (OrbStack, arm64 host pulling amd64 by default) | ✅ | every proof this session |
| rootful Podman 5.8 on Fedora 44, SELinux enforcing | ✅ | `[spec:S45]` 6.1 |
| Docker installed by `init-system` on Rocky 9.8 | ✅ | `[spec:S45]` 6.2 |
| runtime differences held in one profile table | ✅ | `[src:packages/core/src/runtime/container-runtime.ts:246-292]` |
| observation over the API socket only | ✅ | no Go-template parse outside `runtime/` except the allowlisted `[src:packages/core/src/__tests__/arch.test.ts]` (setup, size, stats, builds, checks) |

## Relationships

- Compile **enables** deploy; deploy **requires** the edge for routes and **requires** secrets for any app with a secrets trait.
- Catalog install **shares** the vault with secrets; a locked vault degrades install (F9).
- The control plane **requires** `appbay_shared` and the socket; it **shares** the edge for its own route.
