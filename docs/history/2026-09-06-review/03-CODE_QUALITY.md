# Code quality — 2026-09-06

S1–S13 and Q1–Q7 over function bodies read this session. Every finding cites the lines read.
Ordered: security and data loss → journey breaks → structural coupling → composition →
performance → design debt → readability → hygiene. Severity follows reachability.

## Security and secrets at rest

```
[S13] [HIGH] services/catalog-service.ts:230-247
CAPABILITY:  appbay install with a locked or absent vault
MEANING:     the installer writes the password you typed into a plain file
WHAT:        when setSecret throws, the value is appended to .env.local in plaintext (mode 0600) and install reports success
EVIDENCE:    catch → fallbackSecrets.push(`${name}=${value}`) (230-247); body written at 268-283
IMPACT:      contradicts product promise 2 ("no plaintext secret at rest outside the vault")
FIX:         refuse the install with the two commands to unlock the vault; or amend the promise
DISPOSITION: HUMAN DECISION (04 · D1)
EFFORT:      SMALL
```

```
[S13] [MEDIUM] secrets/master-password.ts:110-157
CAPABILITY:  every vault-backed secret
MEANING:     the key to the vault is a file next to the vault
WHAT:        the master password persists in plaintext at var/lib/secrets/master-password (0600); APPBAY_MASTER_PASSWORD overrides
EVIDENCE:    resolveMasterPassword reads env then the file (110-133); persistMasterPassword writes it (143-157)
IMPACT:      an attacker with file access to the home reads both; promise 2 reads stronger than this
FIX:         state the tier in product.md (T3b with an on-disk key), or take the key from the OS keychain / operator prompt on service installs
DISPOSITION: HUMAN DECISION (04 · D2)
EFFORT:      MEDIUM
```

```
[Q3] [LOW] apps/cli/src/commands/up.ts:82-86
CAPABILITY:  appbay up <app> --open
MEANING:     the app name goes through a shell
WHAT:        exec(`appbay open ${appName}`) builds a shell string from argv
EVIDENCE:    line 85; appName is the raw positional
IMPACT:      self-inflicted only (operator's own shell), but it is the one shell-string spawn in the CLI
FIX:         spawn("appbay", ["open", appName])
DISPOSITION: FIX NOW
EFFORT:      TRIVIAL
```

## Journey breaks

```
[S4] [HIGH] schemas/appbay-yaml.ts:288; secrets/resolve-for-deploy.ts:140,212,294; traits/definitions/secrets.ts:50,132,177
CAPABILITY:  secrets trait, injection: wrapper-live
MEANING:     a manifest can ask for a mode that does nothing, and the app starts without its secret
WHAT:        the enum accepts "wrapper-live"; no branch in the trait or the resolver handles it, so the ref is neither exported nor written
EVIDENCE:    every dispatch tests runtime-env, wrapper-file or entrypoint-wrapper only; no "wrapper-live" outside the enum (git grep)
IMPACT:      silent: no error, container runs with the variable unset
FIX:         remove "wrapper-live" from the enum and from product.md / secrets.qmd until it exists
DISPOSITION: FIX NOW
EFFORT:      TRIVIAL
```

```
[Q1] [MEDIUM] services/deploy-service.ts:598-607, 644-656, 660-669, 758-768, 795-800
CAPABILITY:  project ordering (etc/projects.yaml)
MEANING:     an app can be started although the app it waits for never started
WHAT:        five failure branches `continue` without notReady.add(app): compile error, wrapper-file secret failure, pre-deploy shepherd failure (both paths), compose failure on the unchanged path
EVIDENCE:    contrast with 611-619 and 690-699, which do add; the readiness wait at 838-857 is skipped by every `continue`
IMPACT:      dependents deploy; their own readiness may pass while the dependency is absent; report reads "deployed"
FIX:         one `fail(appResult, error)` helper that records, counts and blocks; call it from every branch
DISPOSITION: FIX NOW
EFFORT:      SMALL
```

```
[Q1] [MEDIUM] runtime/observe.ts:225-229 vs traits/definitions/hooks.ts:116-130
CAPABILITY:  readiness of an app with an init hook and dependents
MEANING:     an app that ran its setup step correctly is reported "not ready" until the timeout
WHAT:        isReady requires every container to be running; a hooks init service is a one-shot (restart: "no") that exits 0 and stays "exited"
EVIDENCE:    filter `r.state !== "running"` (227); findCrashedServices (185) already treats exit 0 as not a crash
IMPACT:      every project-ordered deploy behind such an app waits readiness.timeout_seconds and then fails
FIX:         treat `exited` with exitCode 0 as done in isReady
DISPOSITION: FIX NOW
EFFORT:      TRIVIAL
```

```
[Q1] [MEDIUM] services/catalog-service.ts:207,217,224
CAPABILITY:  appbay install <entry> --as <name>
MEANING:     two installs of one catalog entry share one set of secrets
WHAT:        vault keys are `${name}/${input}` where name is the catalog entry, not installAs
EVIDENCE:    installAs computed at 112, unused in the three ref/setSecret lines
IMPACT:      the second install silently reuses (or overwrites) the first's DB password
FIX:         key by installAs
DISPOSITION: FIX NOW
EFFORT:      TRIVIAL
```

```
[S3/Q1] [MEDIUM] compiler/compile.ts:533-541; compiler/overlay-engine.ts:145-165; compiler/renderer.ts:80-105
CAPABILITY:  two conditional overlays on one service
MEANING:     only the last overlay's environment and labels survive
WHAT:        compile.ts pre-merges overlay fragments with `{...a, ...b}`; two correct deep merges exist beside it and are not used here
EVIDENCE:    measured: overlays for peers b and c both adding environment → render carries FROM_C only (scratch run this session)
IMPACT:      the overlays guide promises a deep merge (overlays.qmd:124)
FIX:         merge with mergeServiceFragment; delete the copy in overlay-engine so one merge remains
DISPOSITION: FIX NOW
EFFORT:      SMALL
```

```
[Q5] [MEDIUM] apps/cli/src/commands/server.ts:54-66
CAPABILITY:  server status / start
MEANING:     when the runtime cannot be asked, the CLI says the server is stopped
WHAT:        isServerRunning and getServerInfo return false/not-running on Inspection.unknown
EVIDENCE:    `state.kind === "ok" && state.value` (56); `detail.kind !== "ok" → running:false` (64)
IMPACT:      `server start` on a degraded host tries to start over a running server; status lies
FIX:         surface unknown with its reason, as deploy does
DISPOSITION: FIX NOW
EFFORT:      SMALL
```

```
[S2] [HIGH] traits/definitions/secrets.ts:248-255; tools/appbay-inject
CAPABILITY:  injection: entrypoint-wrapper
MEANING:     the documented highest-security mode needs a binary the product never delivers
WHAT:        the trait mounts $APPBAY_HOME/bin/appbay-inject; no build, release or init step creates it
EVIDENCE:    S45 live runs on Docker and Podman; works once built by hand
IMPACT:      the container exits before its entrypoint; the guide now says so
FIX:         static injector for both container arches, embedded and written by init; doctor reports its absence
DISPOSITION: SCHEDULE (issue #11)
EFFORT:      LARGE
```

## Structural

```
[S4] [MEDIUM] traits/definitions/backup.ts:38-40; services/deploy-service.ts:494-513
CAPABILITY:  backup trait
MEANING:     declaring a backup schedules nothing on a CLI-only install
WHAT:        the trait returns compose unchanged and emits metadata for a job queue that lives in the web control plane
EVIDENCE:    deploy warns "backup declared but NOT SCHEDULED"
IMPACT:      stated, not silent; still a half-stack feature in this tree
FIX:         drop the trait from the CLI's documented surface, or ship a scheduler
DISPOSITION: HUMAN DECISION (04 · D3)
EFFORT:      ARCHITECTURAL
```

```
[S5] [LOW] apps/cli/src/commands (18 files spawn); docs/steering/structure.md
CAPABILITY:  boundary "apps/cli: argv in, text out"
MEANING:     the CLI layer still runs container and host commands itself
WHAT:        logs, exec, pull, up --tail, dive, mcp, tunnel spawn the container CLI directly; init-system, setup, fixfs, size, stats spawn host tools
EVIDENCE:    per-file spawn inventory this session; the arch rule for spawns is scoped to core
IMPACT:      a runtime difference in `logs -f` or `exec` would be fixed in the CLI, outside the profile table
FIX:         route container invocations through runtime/ (a `containerExec` already exists); host-tool spawns are correct where they are
DISPOSITION: SCHEDULE
EFFORT:      MEDIUM
```

```
[S5] [LOW] compiler/compile.ts:606,709
CAPABILITY:  compile
MEANING:     the compiler guesses where the install root is
WHAT:        join(appsDir, "..", "..") twice, to read ingress provider and instance config
EVIDENCE:    the design anchor says core is handed the home, not re-derives it
FIX:         pass appbayHome in CompileOptions (compileInstall already has it)
DISPOSITION: SCHEDULE
EFFORT:      SMALL
```

```
[S3] [LOW] services/vault-service.ts:130-131,161-164; secrets/providers/keepass.ts:81-82,158,181
CAPABILITY:  KeePass backend
MEANING:     the same env vars are read in two places
WHAT:        APPBAY_KEEPASS_DB and APPBAY_KEEPASS_KEYFILE resolved in the service and again in the provider
FIX:         one resolver beside master-password.ts
DISPOSITION: SCHEDULE
EFFORT:      SMALL
```

## Performance

```
[Q4] [LOW] apps/cli/src/commands/apply.ts:31,79
WHAT:        apply compiles every app to plan, then deploy() compiles them again
DISPOSITION: ACCEPT — correct, and compile is sub-second per app
```

## Design debt and readability

```
[S10/Q7] [LOW] apps/cli/src/utils/docker.ts:79-88
WHAT:        cliRuntimeProfile / cliContainerBin exist "because the CLI honours ~/.config/appbay/home and core does not"; core's resolveHome has honoured it since S37 (runtime/home.ts), so the comment is stale and the wrappers are indirection without a difference
FIX:         delete the wrappers or correct the comment
DISPOSITION: SCHEDULE
EFFORT:      SMALL
```

```
[Q5] [LOW] services/deploy-service.ts:620-627; apps/cli/src/commands/server.ts:96-104
WHAT:        nested try/catch around the .env copy ends in `catch { /* ignore */ }`; server health polls by spawning host curl
FIX:         one try with an explicit "no .env" branch; fetch() for the health probe
DISPOSITION: SCHEDULE
EFFORT:      TRIVIAL
```

```
[Q1] [LOW] health/checks.ts:578-597
WHAT:        checkGpu reports "failed" when nvidia-smi is absent; absent tooling is unknown, not a failed GPU
DISPOSITION: SCHEDULE (optional check; does not affect ok)
```

## Hygiene

```
[hygiene] [LOW] repo
WHAT:        no linter is configured (`turbo lint` runs nothing); knip lists 4 unused exports (DEFAULT_PROJECT, withIdentity, parseKeePassUri, parseVaultUri)
FIX:         remove the exports now; adopt eslint with the strict TS preset in a sprint
DISPOSITION: FIX NOW (exports) / SCHEDULE (linter)
```

```
[S7] [LOW] docs/guide/overlays.qmd:124-126
WHAT:        says overlays are merged before traits; compile applies traits (Stage 2d) and merges overlay fragments at render (2e)
DISPOSITION: FIX NOW (docs, Phase B)
```

## What passed

- Layer direction: no upward import between core layers; the CLI takes core through its barrel only.
- Spawns in core are in `runtime/` or on the shrinking allowlist; no Go-template parse of runtime output outside `runtime/` beyond the allowlist.
- Vault: scrypt with a per-vault salt, AES-256-GCM, versioned header; the master password has one resolver.
- Shepherd payloads travel on stdin; names are validated; the writer is tested on padded values.
- Doctor and deploy are three-valued end to end; `buildDoctorJson.ok` derives from required checks only.
- Specs: 14 sprints, all CLOSED with a linear `depends_on` chain, ids matching directories, anchors declared; no open task in a closed spec.
