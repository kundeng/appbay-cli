---
spec_id: S32-rfc-001-core
status: ACTIVE
closed_as: null
since: 2026-08-31
activated: 2026-08-31
until: null
epic: security
features: [namespace-axis, system-home-consolidation, identity-collapse, when-semantics]
supersedes: []
superseded_by: null
depends_on: [S30-rfc-001-consolidation]
anchors: [data-architecture]
---

# S32: RFC-001 core — identity, system home, namespace, `when`

<!-- ACTIVE 2026-08-31, on S30's FORK-FORWARD close. Carrier for everything S30 deferred.
     ⚠️ S31 is the PRIVATE queue's S31-alpha-remainder. Sprint numbers are one global
     sequence across two queues, so the CLI's next number is 32. -->

# 1 · Requirements

## Introduction

S30 shipped the two halves of RFC-001 that its own Sequencing table called independently
shippable: 3.1 (argv containment) and §6 (catalog sourcing). This carries the rest — §1
identity, §2 system home, §4 namespace, §5 `when`, plus the secrets items that the RFC
sequences behind §2.

These are one sprint rather than four because they are genuinely coupled: §1 and §3's
remainder both depend on §2 putting one master password in one place, and §4 and §5 both
rewrite the same compiler inputs.

**Read before starting:** `docs/rfc/RFC-001-consolidation.md` (the spec),
`docs/rfc/FINDINGS.md` (the measured basis), `docs/rfc/evidence/` (17 probe records), and
`specs/S30-rfc-001-consolidation/spec.md` (what is already done, and the corrections that
changed the RFC's own conclusions).

## Mental Model & Invariants

Carried from S30, because they were learned the expensive way and still apply:

1. **The RFC audited the subset.** `appbay-cli` is a strict subset of the private `appbay`
   tree. A `grep` here proving "no callers" proves no callers *here*. S30 re-measured five
   such claims; three held and two did not.
2. **Removing the shell is not removing the exposure.** A secret in a command-line
   *argument* is exposed whether or not a shell is involved.
3. **Run it before believing it.** Every defect S30 found beyond the RFC's list —
   `edit --password` not existing, `db-create` prompting twice, `--catalog` seizing
   `bundled` — was invisible to reading and to `tsc`.

- **I1** No secret value appears in any process's `argv`.
- **I4** A change measured against the public subset is not proven until it is checked
  against `apps/web`, because that is where the merge breaks.
- **I5** 🚨 **§1.1 is a migration, not a deletion.** The `passwordHash` column has nine
  consumers, all in the private tree, including the sign-in check at
  `apps/web/src/app/api/auth/[...all]/route.ts:152`. Dropping it here breaks web-UI login on
  the next `git merge upstream/main`, with no diff on this side to point at.
- **I6** 🚨 **§5.1 touches six sites and two implementations.** `apps/web` carries its own
  `discoverRunningApps` at `server/docker-utils.ts:25`, feeding `activeApps` into the same
  compiler from `queue/workers/eject.ts:51` and `routers/deployments.ts:20`. Land both sides
  in one private commit, then cherry-pick the public half.

## Decisions & Corrections (log)

**2026-08-31 — §4 is NOT one text edit; it is two changes with different costs.** Measured
before touching anything:

- The **declaration fields** are free, as the RFC says. All 155 manifests declare
  `project: default` / `environment: default` and carry no information. Confirmed by
  execution that the invocation value is unreachable: `AppbayYamlSchema.parse({})` yields
  `project: "default"`, so `config?.project ?? "uom.sim"` returns `"default"` [F51/F52].
- The **reference vocabulary is a 234-site migration across two repos.** `${{project.` appears
  **234** times in the real catalogs, the UOM fixtures and `system-apps/`; `${{environment.`
  and `${{service.` appear **zero** times. RFC 4.2 says to collapse `ScopeValues` and
  `VALID_SCOPES` (`scope-resolver.ts:20-22`, `:50`), which renames that vocabulary and breaks
  all 234. F51's "the fields carry no information" is true of the *declaration*, and the RFC
  carries it over to the *vocabulary*, which is a different surface.

⇒ Split: task 1.1 does the declaration fields, which are separable — `appProject` feeds only
`resolveMagicVars`' key tuple (`compile.ts:446`) and the trait context (`:555`), never the
resolver, which is fed from the separate `projectVars` input. The vocabulary rename becomes
its own task with an alias period, and needs a decision before it runs.

**2026-08-31 — 🚨 collapsing the generated-value key changes `?gen=hash` VALUES.**
`generateHash(project, environment, service, key)` is returned *as the value* at
`generated-values.ts:223` for `type === "hash"` — never stored. So a 4-tuple → 3-tuple
collapse silently changes every hash-derived secret on every host. The RFC's "migration cost
is nil" rests on `generated-values.yaml` being `values: []`, which proves nothing here,
because hash values are recomputed each render rather than persisted.

Current exposure measured as **zero**: `?gen=hash` appears nowhere in `appbay-catalog`, the
UOM fixtures, or `system-apps/` — all 54 generated values are `gen=password`, which *is*
stored. So this is safe to land now and would not have been later. Task 1.2 carries the note.

## Requirements

### Requirement 1: One master password, in one place (§2)

1.1 THE system SHALL resolve a master password through exactly one function:
    `APPBAY_MASTER_PASSWORD` → `var/lib/secrets/master-password` → generate-and-persist.
1.2 THE system SHALL merge `InstanceConfigSchema` and `SystemConfig` into one
    `etc/system.yaml`, and `appbay init` SHALL create the secrets directory unconditionally.
1.3 WHEN the asserted `home` disagrees with the resolved path, THE system SHALL fail loudly.

### Requirement 2: One namespace axis (§4)

2.1 THE manifest schema SHALL replace `project` + `environment` with
    `namespace: z.string().optional()`.
2.2 WHEN a namespace is given at the invocation, THE compiler SHALL use it — today
    `compile.ts:380-381` reads `config?.x ?? defaultX` against fields declared
    `z.string().default("default")`, so the `??` never fires and any flag is silently ignored.
2.3 THE namespace SHALL enter container, network and ingress identity, and SHALL be
    DNS-folded (dot → hyphen) wherever it reaches a DNS label.

### Requirement 3: `when` means installed, not running (§5)

3.1 THE compiler SHALL evaluate `when:` against the declared app set, not a `podman ps`
    snapshot, and SHALL use the FULL declared set rather than the invocation's target set.

### Requirement 4: Identity collapses to the edge (§1)

4.1 THE control-plane account concept SHALL be removed, AFTER `renderEdgeSecurityBlock` is
    wired and `apps/web` is cut over to the edge identity store (I5).

### Non-Functional

- **NF 1** — Every commit is one-sided; `check-straddle.mjs` exits 0.
- **NF 2** — 4.1–4.2 land while all 155 manifests still read `default`/`default`. After the
  tier exists it stops being a text edit and becomes a data migration.

## Out of Scope

- Everything S30 already shipped: 3.1, 6.1, 6.2, 6.4, 6.5, 6.6, 6.7.
- 3.7 — verified a no-op: `appbay-catalog` uses `vault://` 39 times and `keepass://` zero.
- The Ansible-native deployment path for the UOM stack (`llm-stack@main`).

---

# 2 · Design

To be written at activation, against the RFC and its findings. Do not re-derive them.

**Sequencing is load-bearing and is the RFC's, as corrected by S30:**

| order | item | why here |
|---|---|---|
| 1 | 4.1–4.2 namespace | A text edit today, a data migration once the tier exists. |
| 2 | §2 system home + master password | §1 and §3's remainder both depend on it. |
| 3 | 3.2–3.5, 3.8 | Need §2. |
| 4 | 1.4 wire the IdP renderer, then the `apps/web` cutover, then 1.1 | I5. |
| 5 | §5 `when`, then 4.3–4.6 | 5.1 deletes the function 4.3 would fix — do `when` first. |
| 6 | 4.7–4.8, 2.5 salt migration | 2.5 is a file-format change; give it room. |

**Testing strategy:** as S30 — a fix is proven by running it. Two modules in S30 had zero
coverage and were hiding always-failing commands. `packages/core` and `apps/cli` suites plus,
for anything touching the runtime, a journey on both VMs.

---

# 3 · Tasks

## Status marks
<!-- [ ] pending | [x] done | [!] BLOCKED: reason | [-] DROPPED: <reason> | [>] → <spec_id> -->

## Tasks

- [ ] 0. Carried from S30
  - [ ] 0.1 Verify a converge path end-to-end with the PACKAGED binary
    - S30's 4.4. Needs a release tag to exist first. Expect `bundled(150), local(5)` and two
      override lines from `appbay catalog list`. Covers S30's changes and this sprint's.
    - **Depends**: —

- [ ] 1. Namespace (§4) — first, while it is still a text edit
  - [x] 1.1 `namespace: z.string().optional()` replaces `project` + `environment`
    - `ScopeSchema` and `AppbayYamlSchema`. Measured before: `parse({}).project === "default"`,
      so `?? invocation` could never fire. Measured after: no-namespace manifest → invocation
      wins; pinned manifest → manifest wins; neither → "default".
    - **Depends**: — · **Requirements**: 2.1 · **Pillar**: MVP
  - [x] 1.2 Collapse the pair-keyed sites and the generated-values key from 4-tuple to 3-tuple
    - Sites: `compile.ts:370,371,380,381,446,447,555,556`; `state.ts` `GeneratedValueKeySchema`
      and `ActiveAppEntrySchema`; `generated-values.ts` `generateHash` + `keyString`;
      `status.ts:49,50,67,68,86,87`; `list.ts:28,29,70,71`.
    - ⚠️ Changes every `?gen=hash` value (see the log). Exposure is zero today and will not
      stay that way — land it now or not at all.
    - ⚠️ Do NOT touch `svc.environment` in `secrets.ts`, `scoped-env.ts` or
      `vault-service.ts`: that is Compose's service environment, which RFC §4 explicitly
      keeps.
    - Landed with 1.1 (one atomic change — the tree does not compile in between).
      `CompilerContext.namespace`, `CompileOptions/CompileAppInput.namespace`,
      `GeneratedValueKeySchema`, `ActiveAppEntrySchema`, `generateHash`, `keyString`,
      `resolveMagicVars`. 12 test files plus 3 yaml fixtures updated.
    - **Depends**: 1.1 · **Requirements**: 2.2 · **Pillar**: MVP · **Properties**: (new) 1
  - [ ] 1.2b 🚦 Decide the `${{project.KEY}}` → `${{namespace.KEY}}` vocabulary rename
    - 234 references across two catalog repos plus `system-apps/`. Needs an alias period in
      `scope-resolver.ts` (accept both, warn on the old) and a sweep of both catalogs, or an
      explicit decision to keep `project` as the reference scope name while the declaration
      field is `namespace`. Not free, and not this task.
    - **Depends**: 1.1
  - [x] 1.3 Namespace into container/network/ingress identity, with `dnsSafe()`
    - New `compiler/identity.ts` owns all six generated names. The alias was built in three
      places independently and is a CONTRACT — it is the host the edge dials — so the
      duplication was a fork waiting to happen.
    - 🚨 **The namespace is OMITTED when absent or "default"**, which is what keeps this from
      being a migration. All 155 manifests declare none, so unconditional inclusion would
      rename every container on every existing host to disambiguate nothing. Tested:
      `undefined`, `"default"` and `""` all reproduce the pre-§4 names byte for byte.
    - `dnsSafe()` folds dots→hyphens wherever the namespace reaches a hostname [F54].
    - **Depends**: 1.2 · **Requirements**: 2.3 · **Properties**: 4 · **Pillar**: MVP
  - [x] 1.3b RFC 4.3 — make running-app discovery namespace-aware
    - Not "moot" after all, which the §5 audit had concluded. §4.4 puts the namespace in the
      container name, and `apps/web`'s surviving copy parsed the FIRST segment — so
      `appbay.uom-sim.litellm.litellm` reports the app as `uom-sim`. Segment counting cannot
      fix it (`appbay.<app>.<svc>` and `appbay.<ns>.<app>` are the same shape), so the
      compiler stamps `com.appbay.app` and the reader uses it, with the name as fallback.
    - **Depends**: 1.3
  - [x] 1.5 🆕 Removed scope fields fail instead of vanishing, and the docs stop teaching them
    - Not in the original plan; found by the docs pillar check. Zod strips unknown keys, so
      after 1.1 a manifest saying `project: homelab` parsed clean and the value disappeared
      with no error. `default` is still accepted (all 162 real declarations said it, and it
      carried nothing); anything else is a parse error naming `namespace:`.
    - Three system apps declared `project: system` and it was load-bearing — apps/web's
      command palette keys its icon off it — so they migrated to `namespace: system`. The
      other nine dropped a dead `default`.
    - `docs/guide/overlays.qmd` and `docs/reference/scope-model.qmd` rewritten. The first
      documented §5.2's defect as the design ("the active app set is determined from CLI
      arguments"); the second taught a syntax that now errors, plus two variable stores that
      never existed.
    - **Depends**: 1.1, 1.3 · **Pillar**: Docs, Design
  - [x] 1.6 🆕 Docs guards: manifests are checked, and check:docs-cli is green again
    - Bug sweep found zero open issues and zero TODO/FIXME in either tree, so the smallest
      real defect was this session's own: `docs/reference/appbay-yaml.qmd` still taught
      `project:`/`environment:`, which now hard-fail.
    - `scripts/check-docs-manifests.mjs` parses every yaml block under `docs/guide` and
      `docs/reference` through `AppbayYamlSchema`. It found FIVE more broken blocks beyond
      the two known. 61 manifests now parse; proven to exit 1 on a reintroduced break.
    - ⚠️ `check:docs-cli` had been exiting 1 since `8274ac1` — measured — because it scanned
      `docs/rfc/` and `docs/history/`, where naming a proposed or removed command is the
      point. Scoped to the 24 operator-facing files; 0 discrepancies, still catches a fake
      flag and a fake command.
    - **Depends**: 1.5 · **Pillar**: Docs, Test
  - [ ] 1.4 Fix the `compile.ts:435`/`:517` suggestion — it names two files nothing reads and
        two flags that do not exist
    - **Depends**: 1.1

- [ ] 2. System home (§2)
  - [ ] 2.1 Merge `InstanceConfigSchema` + `SystemConfig` into `etc/system.yaml`
    - **Depends**: — · **Requirements**: 1.2
  - [ ] 2.2 One `resolveMasterPassword()`; delete the keepass ladder and both duplicate resolvers
    - **Depends**: 2.1 · **Requirements**: 1.1
  - [ ] 2.3 Fold `secrets init` into `init`; keep `rotate-password`, `repair-password-file`
    - **Depends**: 2.2
  - [ ] 2.4 Assert `home` against the resolved path and fail loudly on disagreement
    - **Depends**: 2.1 · **Requirements**: 1.3

- [ ] 3. Secrets remainder (§3)
  - [ ] 3.1 Narrow the manifest `provider:` enum to `vault` and reject the other four
    - **Depends**: 2.2
  - [ ] 3.2 Route `set-kdbx`/`get-kdbx`/`delete-kdbx` through `secrets set|get|delete`
    - `set-kdbx` still takes the value as argv (`secrets.ts:591`) with no stdin path — the
      exposure `secrets set` was already fixed for. **This is an I1 violation still live.**
    - **Depends**: 2.2 · **Requirements**: (I1)
  - [ ] 3.3 Extract the duplicated scope/key split into one exported helper
    - **Depends**: —
  - [ ] 3.4 Fix the `vault.ts:96-101` comment — the depth is unbounded
    - **Depends**: —

- [x] 4. `when` (§5)
  - [x] 4.1 `installedApps` replaces `activeApps` — EIGHT sites, and the function survives
    - Sites were up/apply/compile/eject (cli), plans/deployments/eject-worker/apps (web) —
      the RFC lists four. `discoverRunningApps` is NOT deleted: it also drives the web UI's
      running/stopped indicator, a real runtime question §5 does not touch. What died is
      `deploy()`'s now-dead `discoverRunning` option.
    - ⚠️ **Audit correction (2026-08-31).** "The function survives" was half right and I
      wrote it as if it were whole. There are TWO copies. `apps/web`'s has real callers
      (`apps.ts:52`, `:88` — the running indicator) and stays. `apps/cli`'s had exactly the
      four overlay callers §5 removed, and the CLI reports running state nowhere — so it was
      dead, and RFC 5.1's "delete it" was right for that copy. Deleted, with its ten tests.
      Those tests are why it looked alive: they exercise the function directly rather than
      any path reaching it, so coverage stayed green while the last caller disappeared.
    - ⭐ The `apps.ts` overlay GRAPH was the one that mattered: it evaluated
      `isWhenSatisfied` against the RUNNING set while the compiler used installed, so the UI
      would have drawn an overlay inactive that the render applied. Two answers to one
      question, disagreeing silently.
    - **Depends**: — · **Requirements**: 3.1 · **Properties**: 3
  - [x] 4.2 The set is derived INSIDE compile(), before the target filter
    - This is what makes `appbay up open-webui` and `appbay up` byte-identical for
      open-webui. Accepting it from the caller was the mechanism of the bug. Tested.
    - **Depends**: 4.1 · **Requirements**: 3.1 · **Properties**: 3
  - [x] 4.3 Overlay skip reasons say *installed*
    - `missing app(s) X` → `app(s) not installed: X`; `none of X are active` → `are
      installed`. `whenClauseLabel()` needed nothing — it renders `when: a + b` and never
      spoke about activation.
    - **Depends**: 4.1

- [ ] 5. Identity (§1) — last, and as a migration
  - [ ] 5.1 Wire `renderEdgeSecurityBlock` + `edgeSecretEnvMapping` with provider selection
    - Complete and unreachable today: zero callers, zero tests, in BOTH trees.
    - **Depends**: 2.1
  - [ ] 5.2 Cut `apps/web` over to the edge identity store
    - **Depends**: 5.1 · **Requirements**: 4.1
  - [ ] 5.3 Only now: delete `admin.ts`, the schema module, `hashControlPlanePassword`, the
        `retired.ts` branch, and the `passwordHash` column
    - **Depends**: 5.2 · **Requirements**: 4.1
  - [ ] 5.4 Import any existing `users.yaml` accounts and print what happened
    - **Depends**: 5.3

- [ ]* 6. Vault format (2.5)
  - [ ]* 6.1 Per-vault salt with a format version byte and a read path accepting both shapes
    - `SCRYPT_SALT` is the constant `"appbay-vault-v1"`, so two hosts sharing a password hold
      interchangeable vault files. Not a one-line change: the file is `IV(12) + tag(16) +
      ciphertext` with no header.
    - **Depends**: 2.2

## Notes

Carried from S30 on its close. Nothing here is started.

**2026-08-31 — the verification gate was wrong, and it was mine, not the repo's.** The
namespace commit landed in both trees reporting `pnpm -r test` green (core 857, cli 379, web
474) while **`apps/cli` and `apps/web` both failed to typecheck** — 7 errors in web, 6 in
cli. vitest transpiles; it does not typecheck. My first write-up blamed the repo ("no script
here typechecks apps/cli or apps/web") and that is false: `pnpm typecheck` exists, is wired
through turbo to all six packages, and passes. Both commit messages were corrected.

⇒ **The gate for this sprint is `pnpm typecheck` AND `pnpm -r test`, not either alone.** And
after cherry-picking core source into the public tree, run
`pnpm --filter @appbay/core build` first — `apps/cli` resolves `@appbay/core` through
`main: dist/index.js`, so a stale `dist` typechecks against the old `.d.ts` and hides the
breakage a second time.

**2026-08-31 — §4 reached further into `apps/web` than a rename.** The sidebar grouped apps
*by environment*, an axis §4 deletes. So the collapse forced a UI model change, not a type
patch: sidebar groups by namespace, scope-chips shows one `ns` pill instead of two, the
config tab derives one field, the command palette keys off namespace. Invariant I4 fired on
my own change — exactly the case it was written for.

**2026-08-31 — `discoverRunningApps` has two purposes and §5.1 only kills one.** It feeds
status display (`apps.ts:52`, `:89` — "is this app up?") *and* overlay `when:` evaluation
(`apps.ts:295`). RFC 5.1 says "delete `discoverRunningApps()`"; deleting it would take out
the running/stopped indicator in the web UI. §5 replaces the overlay caller only.

## Correctness Properties

### Property 1: the invocation reaches the compiler
- **Statement**: *For any* manifest that does not declare `namespace`, the value passed into
  `compile()` is what the compiler uses; *for any* manifest that does, the manifest wins.
- **Validates**: Requirement 2.1, 2.2
- **Test approach**: `appbay-yaml.test.ts` asserts `namespace` is `undefined` and the key
  absent on `parse({})` — a default there silently breaks every `--namespace` again.

### Property 4: an un-namespaced host is not renamed
- **Statement**: *For any* app, when the namespace is absent or `default`, every generated
  name equals what appbay produced before RFC-001 §4.
- **Validates**: Requirement 2.3, and the absence of a migration
- **Test approach**: `identity.test.ts` asserts the legacy strings for `undefined`,
  `"default"` and `""`. If these change, every existing host renames on next converge.

### Property 3: targeting does not change the artifact
- **Statement**: *For any* app, `compile({apps: [X]})` and `compile({})` render X identically.
- **Validates**: Requirement 3.1
- **Test approach**: `overlay-integration.test.ts` "targeting one app does not change what it
  renders", plus the same property in `compile.test.ts`. Both assert byte equality of the
  rendered output, not just that the overlay fired.

### Property 2: the namespace is load-bearing in generated values
- **Statement**: *For any* two namespaces, the same app + variable yields different values.
- **Validates**: the two-instances-in-one-home goal of §4
- **Test approach**: `generated-values.test.ts` "different inputs" varies one component per
  pair and asserts all four digests differ.

**2026-08-31 — RFC 4.3 was not moot, and my §5 audit said it was.** The audit concluded
4.3 (make `discoverRunningApps` namespace-aware) died with §5's caller removal. That held
only until §4.4 put the namespace into the container name — at which point the *surviving*
web copy mis-parses it. Two corrections one after the other on the same item: first "the
function survives" (half true), then "4.3 is moot" (true only until the next task). The
lesson is the same both times — a claim about a function with two copies needs to name which.

**2026-08-31 — sequencing correction.** After §5 the next unit is **1.3** (RFC 4.4–4.6:
namespace into container/network/ingress identity, with `dnsSafe()`), NOT §2. The design
table above says so — "§5 `when`, then 4.3–4.6" — and I stated §2 as next in a status
report, which contradicts this spec's own ordering. RFC 4.3 itself is now moot: it asked for
`discoverRunningApps` to be made namespace-aware, and §5 removed the caller that needed it.

**2026-08-31 — §5's test suite could express states the system cannot reach.** The overlay
tests handed `compile()` an `activeApps` set, so "ollama is installed but not active" was a
value a caller could pass and the compiler would honour. With the set derived from the tree,
each case must build the tree it describes — and doing so exposed two fixtures that had
never tested what they claimed: `searxng` is not in `SYSTEM_APPS`, so the AND-overlay case
had never installed the peer it asserted on; and `result.apps[0]` stopped being the app under
test once installing a peer meant compiling it too ("caddy" sorts before "myapp"). Both were
my bugs, both surfaced by running it.

**2026-08-31 — the docs check found a code defect, not a docs defect.** Verifying whether
`scope-model.qmd` still matched the code turned up that a removed field was being silently
stripped by Zod rather than rejected — so the doc was teaching syntax that failed quietly
rather than loudly. The doc fix was the smaller half. Rung 3 before rung 4 is why it
surfaced: checking the build against the design first is what made the doc gap legible.

## Log

**2026-08-31** — Created DRAFT as S30's deferral carrier. Numbered 32 because S31 is the
private queue's `S31-alpha-remainder` and the two queues share one number sequence.
