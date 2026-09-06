# Reconciliation plan — 2026-09-06

Where human intention (`docs/steering/`, `docs/design/`), the specs, and the code disagree,
grouped by area and root cause. Each row names the intention, the code reality, the spec
claim, the recommendation, and the decision it needs. An action marked APPROVED is executed
by the next sprint; PROPOSED and BLOCKED cannot execute.

## A · Secrets at rest (root cause: the promise is stronger than the design)

| id | intention (product.md promise 2) | code | spec | recommendation | decision |
|---|---|---|---|---|---|
| **D1** | no plaintext secret at rest outside the vault | `catalogInstall` writes the typed value to `.env.local` when the vault is locked, announced in the output `[src:services/catalog-service.ts:230-247]` | S38 audited exposure per mode, not the install path | **refuse the install** with the two commands that unlock the vault; the operator re-runs. The fallback was added to fix a silent gap (issue #47); a refusal is the honest version of the same fix | HUMAN DECISION — recommended: refuse |
| **D2** | same | the master password is a 0600 plaintext file beside the vault `[src:secrets/master-password.ts:143-157]`; `APPBAY_MASTER_PASSWORD` overrides | RFC-001 §2 chose the file | state the tier in product.md: the vault key is on disk, protected by file mode and the service account; a service install that wants better takes the key from the OS keychain or a prompt. Changing the design is a sprint | HUMAN DECISION — recommended: state it now, keychain later |
| **F1** | five injection modes | `wrapper-live` parses and does nothing | product.md lists it | remove it from the enum and the docs until it exists | APPROVED (code is right that it does not exist) |
| **#11** | `entrypoint-wrapper` works | needs a binary nothing ships | S38 verified argv only | ship the injector as a static binary, written by init | APPROVED as a scheduled sprint |

## B · Deploy correctness (root cause: exceptions to a rule written inline)

| id | intention | code | spec | recommendation | decision |
|---|---|---|---|---|---|
| **F2** | ordering implies readiness (S39) | five failure branches do not block dependents | S39 2.x | one failure helper | APPROVED (spec is right) |
| **F4** | a service with no healthcheck is ready when it runs (concepts.qmd) | a one-shot init service that exited 0 never reads ready | S39 | exited 0 is done | APPROVED |
| **F3** | overlays deep-merge (overlays.qmd:124) | compile pre-merges with a shallow spread; two deep merges exist unused | none | one merge | APPROVED |
| **F5** | `--as` installs are independent | vault keys use the catalog name | none | key by installed name | APPROVED |
| **F7** | unknown is never a verdict (promise 3) | `server status` folds unknown into stopped | S36/S41 | surface unknown | APPROVED |

## C · Boundaries (root cause: docs describe the target, code describes today)

| id | intention (structure.md) | code | recommendation | decision |
|---|---|---|---|---|
| **F17** | CLI is argv in, text out | 18 command files spawn processes; container spawns in logs/exec/pull/up | move container invocations behind `runtime/`; keep host-tool spawns; say so in structure.md | PROPOSED — sprint after the fix-now set |
| **F13** | core is handed the home | compile derives it from appsDir | pass `appbayHome` in CompileOptions | PROPOSED |
| **F8** | the trait surface is real on the CLI | backup is metadata for a queue that is not in this tree | decide whether the CLI documents backup at all | HUMAN DECISION — **D3** |
| docs | `docs/README.md` says `design/` is absent; data-architecture says runtime reads are "today: parsed CLI text"; product.md says ten system apps and that the modes are unaudited; pillars say Podman is open | all stale after S41–S45 | correct in Phase B | APPROVED (this run) |

## D · Open design questions carried from the ledger

| row | question | recommendation | decision |
|---|---|---|---|
| 28 | multi-home DNS | one domain per namespace; multi-homing in DNS; doctor resolves the host | HUMAN DECISION |
| 22 | single-node Swarm secret store | an experiment on one host before any design | HUMAN DECISION |
| 12 | apps/web references in this tree | out of scope for this repository | ACCEPT |

## E · Next sprint (S46) — the APPROVED set

F1, F2, F3, F4, F5, F6 (shell string), F7, the four unused exports, and the overlays doc
line. Each carries a test that fails before the change. D1, D2, D3, rows 22 and 28 wait for
Kun; nothing in S46 depends on them.
