# Product experience — 2026-09-05

What an operator can do with the CLI today, and whether each capability was seen working
in this review. Status marks: ✅ verified this session (a command run, output read) ·
⚠ partial (works, but reports more than it observed) · ❌ broken with evidence ·
🔬 not demonstrated.

Evidence this session: a real `init`, `up`, `ps`, `status`, `list`, `logs`, `down`, `catalog
list`, `install`, `compile`, and `doctor --json` against a scratch `APPBAY_HOME` on the local
Docker (OrbStack), once with the default traefik provider and once with `--ingress-provider
caddy`. No Podman host was available; Podman claims are read from code and marked so.

## Core experience: an app goes from a catalog entry to a routed container

```
appbay init ──▶ appbay install <entry> ──▶ appbay up <app> ──▶ https://<app>.<domain>
```

The last arrow is the one that does not hold. See area 3.

## Area 1 — Install a host

| capability | status | evidence |
|---|---|---|
| `appbay init --yes --dir …` writes `etc/system.yaml`, installs the system apps for the chosen provider, records the container store | ✅ | ran; `etc/apps` held 11 system apps under traefik, `caddy` replaced `traefik` under `--ingress-provider caddy` |
| `appbay doctor` runs 17 checks; `--json` gives `{ok, checks[]}` | ⚠ | ran, `ok: true`. Seven checks return `passed: true` when they could not look (`health/checks.ts:262-275` "runtime not answering") and `ok` derives from failures only (`checks.ts:1125`) |
| `appbay init-system` installs a systemd unit and service account | 🔬 | Linux only; not run |

<details><summary>Mental model</summary>

An install is a directory, `APPBAY_HOME`, holding `etc/apps/<app>/` (the manifests),
`var/lib/renders/<app>/` (what compose actually runs), `var/lib/state/` (generated values),
and `etc/system.yaml` (domain, provider, store). Doctor reads the host and the directory
and reports per check; the `ok` bit is what scripts key on. Invariant it should hold: `ok`
is true only when every required check ran and passed. Risk: today an unreachable runtime
reads as ok. `[src: packages/core/src/health/checks.ts:262-275, :1125]`
</details>

## Area 2 — Get an app onto the host

| capability | status | evidence |
|---|---|---|
| `appbay catalog list` shows the bundled catalog | ✅ | ran; 154 entries |
| `appbay install <entry>` copies the entry into `etc/apps` | ⚠ | ran; printed "Validation had issues — the app is still installed. Ready to deploy", exit 0. The next `compile` refused the app: its auth trait needs the caddy edge and this install is traefik. Install said ready for an app that cannot compile here `[src: apps/cli/src/commands/install.ts:139]` |
| `appbay install <entry> --as <dir>` installs a second copy | 🔬 | not run; verified in code `[src: packages/core/src/services/catalog-service.ts:109]` |
| `appbay list`, `appbay status <app>` | ✅ | ran; both display the namespace |

<details><summary>Mental model</summary>

Install is a copy plus a validation. The validation's result is printed and then ignored:
the exit code and the "ready to deploy" line do not depend on it. Invariant it should
hold: "ready to deploy" means the manifest compiles on this install's provider.
</details>

## Area 3 — Deploy and route

| capability | status | evidence |
|---|---|---|
| `appbay compile <app>` renders compose plus edge fragments | ✅ | ran; `var/lib/renders/whoami/docker-compose.rendered.yml` and `etc/apps/traefik/config/dynamic/whoami.yml` written |
| `appbay up <app>` on the traefik provider | ⚠ | ran with traefik not running: reported `1 deployed`. The route file was written; nothing checked that an edge exists or loaded it `[src: packages/core/src/services/deploy-service.ts:454, only caddy paths are checked]` |
| `appbay up <app>` on the caddy provider | ❌ | ran with the edge up as `appbay.system.caddy.caddy`: `up whoami` reported "edge routes NOT installed — the Caddy edge container does not exist (no such object: appbay.caddy)" and advised `appbay up caddy`, which had just run. Every ingress app on a caddy install has been unroutable since 0ad179a `[src: packages/core/src/services/deploy-service.ts:416]` |
| `appbay up` detects a container that starts and dies | ⚠ | code-read: one `compose ps` immediately after `up -d`; a container dying later is not seen; a `restart: always` crash loop reports `restarting`, not `exited`, and is not counted `[src: deploy-service.ts:205, :819]`. On Podman the parser handles the banner; `appbay ps` does not |
| `appbay apply` | ⚠ | code-read: a second deploy path; `deployed` on exit code alone, no crash check, no route install `[src: apps/cli/src/commands/apply.ts:111-116]` |
| `appbay ps <app>` | ✅ Docker / ❌ Podman | ran on Docker. On Podman the parser reads from byte 0 and misses the provider banner and `Names[]`; the list comes back empty `[src: apps/cli/src/commands/ps.ts:51-77]` (reasoned) |
| `appbay logs`, `appbay down`, `appbay restart` | ✅ / ✅ / 🔬 | logs and down ran |
| conditional overlays, `when: [peer]` | ⚠ | code-read: true when the peer is declared anywhere in the home `[src: packages/core/src/compiler/compile.ts:251]`. Kun's definition: true when the peer is declared in the same collection. The guide documents the code's meaning `[src: docs/guide/overlays.qmd:13]` |
| two instances of one app in one home | ⚠ | identity separates (namespace in names) but both render the same ingress host; the operator hand-edits `host:` `[src: packages/core/src/compiler/scope-resolver.ts:50; ledger row 10]` |

<details><summary>Mental model</summary>

`up` is compile, then `compose up -d`, then a crash check, then route install, then a
tally. The tally is the operator's only truth. Invariant it should hold: `deployed`
means the container is running and its route is installed on an edge that exists.
Today: on traefik the route is a file nobody checked; on caddy the check targets a
container name the namespace change retired. Rationale for the name: RFC-001 §4 puts
the namespace into every generated name, and the system apps declare `namespace:
system`. The exec targets were written before that and never moved to
`containerName()` or the app label.
</details>

## Area 4 — Secrets and the edge identity

| capability | status | evidence |
|---|---|---|
| vault, KeePass, SOPS providers; `appbay secrets` | 🔬 | no `keepassxc-cli` or `sops` on this machine; the one failing unit test is the `/proc` cmdline check, Linux-only `[src: packages/core/src/secrets/__tests__/keepassxc-cli.test.ts:115]` |
| `appbay edge --ingress-provider <p>` migration | 🔬 | not run; code-read: port ownership read from `ps` reports every port free when `ps` fails `[src: packages/core/src/services/edge-migration-service.ts:77-81]` |
| edge identity restart | ⚠ | code-read: `restart` trusted on exit code, and it targets the retired name `[src: packages/core/src/services/edge-identity-service.ts:139-140]` |

## Area 5 — Operate and maintain

| capability | status | evidence |
|---|---|---|
| `appbay update` | ⚠ | code-read: `pull` wrapped in a try/catch that cannot fire on a non-zero exit; prints `done` regardless `[src: apps/cli/src/commands/update.ts:195-200]` (Node `spawnSync` behaviour proved this session) |
| `appbay server start` | 🔬 | not run; starts the web control plane image, which lives in a separate repo |
| `appbay exec`, `models`, `ollama`, `pull`, `dive`, `size` | ⚠ | code-read: twelve invocations spawn the literal `docker`, so they fail on a Podman host `[src: apps/cli/src/commands/exec.ts:22,43,67 and five more files]` |

## Relationships

- Area 3 requires Area 1's provider choice; a traefik install cannot run apps with the
  auth trait (Area 2's install does not say so).
- Area 3's tally is what Area 5's `update` and the web control plane display.
- Area 4's edge identity shares the retired container name with Area 3.
