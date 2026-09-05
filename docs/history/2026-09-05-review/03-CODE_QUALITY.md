# Code quality — 2026-09-05

Findings grouped by lens, most severe first. Every `EVIDENCE` line names lines that were
read, or a command that was run this session. Static gate: `tsc --noEmit` exit 0 in every
package; `pnpm turbo test`: core 1069 passed, 1 failed, 6 skipped; the failure is a
Linux-only `/proc` assertion run on macOS (`keepassxc-cli.test.ts:115`), a platform
condition the test does not declare.

The seam tables behind the counts are in [seam-review.md](../seam-review.md); the
per-file record is [review-ledger.md](../review-ledger.md). Findings here carry a
`ledger:` pointer where one exists.

## Journey breaks

```
[S1] [CRITICAL] [journey: deploy app on a caddy install]
CAPABILITY:  appbay up <app> with an ingress trait
MEANING:     the app starts and is never reachable; the tool blames the edge that is running
WHAT:        installCaddyConfig execs into "appbay.caddy.caddy" / "appbay.caddy"; the edge is "appbay.system.caddy.caddy"
EVIDENCE:    ran: init --ingress-provider caddy; up caddy → container appbay.system.caddy.caddy Up;
             up whoami → "edge routes NOT installed — the Caddy edge container does not exist
             (no such object: appbay.caddy)". Compile run: caddy renders container_name
             appbay.system.caddy.caddy. Lines: deploy-service.ts:416, edge-identity-service.ts:139,157,
             setup.ts:303,611. Rename landed 0ad179a (2026-08-31); migration path repointed in 9da6a61, deploy path not.
IMPACT:      every ingress app on every caddy host re-deployed since 2026-08-31 is unroutable
FIX:         resolve the edge by containerName("system","caddy","caddy") or the com.appbay.app label at all five sites; one helper in runtime/
DISPOSITION: FIX NOW      EFFORT: SMALL      ledger: 13
```

```
[S1] [HIGH] [journey: deploy app on a traefik install]
CAPABILITY:  appbay up <app> on the default provider
MEANING:     "deployed" is printed with no edge running and no check that one exists
WHAT:        installCaddyConfig returns ok when there are no caddy files; the traefik fragment is written and never validated or loaded
EVIDENCE:    ran: up whoami with no traefik container → "1 deployed"; docker ps showed only whoami;
             etc/apps/traefik/config/dynamic/whoami.yml written. deploy-service.ts:454-456.
IMPACT:      the tally reports a route that may not exist
FIX:         an edge port: installRoute(provider, fragment) that observes the edge on both providers, or reports unknown
DISPOSITION: FIX NOW      EFFORT: MEDIUM
```

```
[S3] [HIGH] [apps/cli/src/commands/apply.ts:111-116]
CAPABILITY:  appbay apply
MEANING:     a second way to deploy that has none of the fixes the first one earned
WHAT:        up -d exit 0 → prints "deployed"; no crash check, no route install, no converge snapshot
EVIDENCE:    apply.ts:111-116 read; compare deploy-service.ts:819-850
IMPACT:      issues 4 and 5 are live again through this command
FIX:         apply calls deploy() with a plan-only flag, or is removed
DISPOSITION: FIX NOW      EFFORT: SMALL      ledger: 14
```

```
[Q5] [HIGH] [packages/core/src/services/deploy-service.ts:194-206]
CAPABILITY:  crash detection after up -d
MEANING:     "could not ask compose" and "nothing crashed" are the same value
WHAT:        findCrashedServices returns null for both; both callers read null as success
EVIDENCE:    :197 comment says null means could-not-inspect; :205 returns null for no-crash; :821 and :944 `if (crashed)`
IMPACT:      on a host where compose ps fails, every deploy reports clean
FIX:         Inspection<T> = {kind:"ok"; value} | {kind:"unknown"; reason} for composePs, findCrashedServices, snapshotContainers, didConverge; unknown surfaces in the app result
DISPOSITION: FIX NOW      EFFORT: SMALL      ledger: 1, 11
```

```
[Q5] [HIGH] [packages/core/src/health/checks.ts:262-275, :1125]
CAPABILITY:  appbay doctor --json
MEANING:     scripts keying on ok:true are told a host is healthy when it could not be inspected
WHAT:        seven checks return passed:true with "not answering"/"cannot determine"; ok derives from failed-required only
EVIDENCE:    checks.ts:262-275 read; buildDoctorJson :1125; ran doctor --json on the scratch home, ok:true
IMPACT:      init-system and CI gates pass on an unreachable runtime
FIX:         a three-valued check result; ok = no failed and no unknown among required
DISPOSITION: FIX NOW      EFFORT: SMALL      ledger: 17
```

```
[Q1] [MEDIUM] [apps/cli/src/commands/update.ts:195-200]
CAPABILITY:  appbay update image pull
MEANING:     "done" prints for a pull that failed
WHAT:        try/catch around spawnSync, which returns a status and does not throw on non-zero
EVIDENCE:    update.ts:195-200 read; proved: node spawnSync("sh",["-c","exit 7"]) → status 7, no throw
FIX:         check .status
DISPOSITION: FIX NOW      EFFORT: TRIVIAL      ledger: 15
```

```
[Q5] [MEDIUM] [packages/core/src/services/edge-migration-service.ts:77-81]
CAPABILITY:  appbay edge --ingress-provider migration, port ownership
MEANING:     when ps fails, every port is reported free and the migration proceeds onto a bound port
WHAT:        ps.status !== 0 → lines = []
EVIDENCE:    :81 read
FIX:         return unknown; refuse the migration on unknown
DISPOSITION: FIX NOW      EFFORT: TRIVIAL      ledger: 18
```

```
[S1] [MEDIUM] [apps/cli/src/commands/install.ts:139]
CAPABILITY:  appbay install
MEANING:     "ready to deploy" for an app that cannot compile on this install
WHAT:        validation failure is caught, printed, and the success path continues with exit 0
EVIDENCE:    ran: install uptime-kuma → "Validation had issues … still installed. Ready to deploy"; compile uptime-kuma → auth trait needs caddy, 1 error
FIX:         exit 1 and say what failed, or say "installed, will not compile here: <reason>"
DISPOSITION: FIX NOW      EFFORT: TRIVIAL
```

## Structural coupling and duplication

```
[S5] [HIGH] [six CLI files]
CAPABILITY:  exec, models, ollama, pull, dive, size on a Podman host
WHAT:        12 invocations spawn the literal "docker"; dive.ts:37 also hardcodes /var/run/docker.sock
EVIDENCE:    exec.ts:22,43,67; models.ts:20,38,49; ollama.ts:5,29; pull.ts:33,52; dive.ts:37; size.ts:17 (grep, 12 hits)
IMPACT:      these commands fail on every Podman install
FIX:         cliContainerBin(); one findOllamaContainer in core
DISPOSITION: FIX NOW      EFFORT: SMALL      ledger: 16
```

```
[S3] [HIGH] [repo-wide — see seam-review.md Seam 4]
WHAT:        one behaviour, several implementations: tryExec ×3, findOllamaContainer ×3, .env parser ×3, home resolver ×5,
             compile() caller ×5 identical, a second doctor (setup.ts:284), two compose-ps parsers, compareSemver ×2,
             appbay.yaml parsed without its schema ×4, system.yaml regex-scraped ×2
EVIDENCE:    sweep tables, spot-checked: tryExec at checks.ts:36 / facts.ts:30 / exec.ts:10; ps.ts:51 vs deploy-service.ts:143; config-service.ts:102,135
IMPACT:      a fix lands once; the podman-banner fix reached deploy and not ps
FIX:         the ownership map (S37): each row gets one owner and the copies are deleted
DISPOSITION: SCHEDULE      EFFORT: LARGE      ledger: 6, 19
```

```
[S5] [MEDIUM] [packages/core/src/services/deploy-service.ts:100-270]
WHAT:        runtime observation (composePs, parseComposePsJson, findCrashedServices, snapshotContainers) lives in a use-case module
EVIDENCE:    no deploy input in any of the four; container-runtime.ts:186 already claims ps --format
FIX:         move to runtime/; didConverge stays or takes typed snapshots
DISPOSITION: SCHEDULE      EFFORT: SMALL      ledger: 7
```

```
[S3] [MEDIUM] [packages/core/src/compiler/identity.ts consumers]
WHAT:        generated names rebuilt by hand outside identity.ts: builds.ts:285, compile.ts:654 (no namespace); appbay_shared in 3 constants and ~30 literals;
             appbay.server declared 3 times; shepherd target prefix built 3 times
EVIDENCE:    sweep table 5, spot-checked builds.ts:285, checks.ts:141, server.ts:37, init.ts:90
FIX:         identity.ts owns them; the P1 above is the same defect
DISPOSITION: SCHEDULE      EFFORT: SMALL
```

```
[S11] [MEDIUM] [specs/*/spec.md frontmatter]
WHAT:        all five specs anchor data-architecture; docs/design/ does not exist
EVIDENCE:    ls docs/design → absent; frontmatter read
IMPACT:      no lifecycle table says which of etc/system.yaml, project.yaml, generated-values.yaml, renders is source of truth
FIX:         write docs/design/data-architecture.md before S37 moves code
DISPOSITION: FIX NOW      EFFORT: SMALL
```

```
[S13] [MEDIUM] [config plane]
WHAT:        21 process.env keys read raw outside the three Zod-parsed ones; cli/index.ts:79 and init.ts:851 write APPBAY_HOME into env so core's private resolvers agree;
             server.ts:261 hardcodes APPBAY_SERVER_CONTAINER_RUNTIME="docker"
EVIDENCE:    sweep table D; container-runtime.ts:106,126,146 are the schematised control group
FIX:         one config loader in core; the CLI passes home, not env
DISPOSITION: SCHEDULE      EFFORT: MEDIUM
```

## Design debt and hygiene

```
[Q6] [MEDIUM] [packages/core/src/compiler/scope-resolver.ts:50; compile.ts:462-466]
WHAT:        VALID_SCOPES still lists environment, always {}; no app scope; the hostname is a manifest literal so two instances collide
EVIDENCE:    scope-resolver.ts:50; compile.ts:462-466; 107 of 109 catalog manifests write host: <name>.${{project.DOMAIN}} (counted)
FIX:         defaultHost from auxFileStem; host: optional; app scope replaces environment; duplicate-host compile error
DISPOSITION: HUMAN DECISION      EFFORT: MEDIUM      ledger: 10
```

```
[Q7] [MEDIUM] [repo-wide]
WHAT:        348 marker comment blocks narrate past fixes; deploy-service.ts is 279 comment lines of 994
EVIDENCE:    counted with rg
FIX:         each block becomes one invariant line; the narrative moves to docs/history; done as functions move in S37
DISPOSITION: SCHEDULE      EFFORT: MEDIUM
```

```
[Q7] [LOW] [dead code]
WHAT:        getKeePassCliVersion (vault-service.ts:409) has no caller; ValidationResult.valid (traits/types.ts:184) has no reader;
             container_name lines in system-apps.ts are overwritten by upstream-transform.ts:163
EVIDENCE:    grep for callers/readers this session
FIX:         install knip, delete what it names
DISPOSITION: SCHEDULE      EFFORT: SMALL
```

```
[Q5] [LOW] [tests]
WHAT:        keepassxc-cli.test.ts:115 asserts /proc contents on every platform
EVIDENCE:    fails on Darwin this session
FIX:         skipIf(platform !== "linux") with the reason
DISPOSITION: FIX NOW      EFFORT: TRIVIAL
```

## Verification

```
[S1] [MEDIUM] [tests]
WHAT:        four tests assert only toHaveBeenCalled on a mocked boundary; no test compiles a system app and asks the deploy path which container it targets
EVIDENCE:    appbay-home.test.ts:91,130; docker.test.ts:152; checks-store-binding.test.ts:135 (sweep, spot-checked)
FIX:         the test that catches the CRITICAL above: compile caddy under namespace system, assert the exec target equals its container_name
DISPOSITION: FIX NOW      EFFORT: SMALL      ledger: 20
```

## Not covered

Secrets providers beyond the cited lines; `packages/db`; `apps/web` (separate repo);
Podman behaviour (no host available, claims marked reasoned); `init-system` on Linux.

## GitHub issues, folded in

```
[S2] [HIGH] [packages/core/src/services/edge-migration-service.ts — issue #7]
CAPABILITY:  safe change of ingress provider
MEANING:     the validate-backup-switch-restore path exists and cannot be reached; init tells the operator to stop the old edge and hope
WHAT:        migrateEdge(), blockingPortConflicts() and their types have no caller; edge.ts registers only user subcommands
EVIDENCE:    grep for migrateEdge( outside its file: none; edge.ts:84-88 adds listUsers/createUser/resetPassword only
IMPACT:      a provider switch is total loss of ingress on any failure, with a tested recovery path sitting unused
FIX:         `appbay edge migrate --to <provider>` calling migrateEdge(); init's advice points at it
DISPOSITION: FIX NOW      EFFORT: SMALL      issue: 7
```

```
[S1] [INFO] [bootstrap on RHEL-family Docker — issue #8]
WHAT:        init-system with container_runtime docker has never completed on any host; Podman path verified on appbay-rhel
EVIDENCE:    issue body; no VM available here either
FIX:         a RHEL-family VM with Docker; pull into the sprint that next touches init-system
DISPOSITION: SCHEDULE      EFFORT: MEDIUM      issue: 8
```

```
[S7] [HIGH] [packages/core/src/compiler/compile.ts:251 — owner definition]
CAPABILITY:  conditional overlays, `when:`
MEANING:     the code answers a different question from the one the owner means
WHAT:        code: `when: [x]` is true when x is declared anywhere in the home (installedApps = every app under etc/apps).
             owner: `when: [x]` is true when x is declared in the same collection as this app — a statement about where a stack is composed,
             independent of whether x is running. docs/guide/overlays.qmd:13 documents the code's meaning as the design.
EVIDENCE:    compile.ts:248-251 read; overlays.qmd:13-40 read; the definition is recorded in docs/steering/product.md
IMPACT:      an app in collection A gets an overlay because a peer is installed for collection B; the wiring crosses stacks silently
FIX:         evaluate `when:` against the app's collection membership; S35 makes a collection a thing with members, so the set exists
DISPOSITION: HUMAN DECISION recorded — the owner decided; SCHEDULE into S35      EFFORT: MEDIUM
```

```
[INFO] [private repo kundeng/appbay — issue #75]
WHAT:        real certificate issuance through the edge is unproven; everything up to the CA round-trip passes
EVIDENCE:    issue title only; the ACME trait lives in this repo (traits/definitions/ingress.ts, acme dns provider config)
DISPOSITION: SCHEDULE — needs a public host or a staging CA      EFFORT: MEDIUM
```
