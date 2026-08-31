---
spec_id: S32-rfc-001-core
status: DRAFT
closed_as: null
since: 2026-08-31
until: null
epic: security
features: [namespace-axis, system-home-consolidation, identity-collapse, when-semantics]
supersedes: []
superseded_by: null
depends_on: [S30-rfc-001-consolidation]
anchors: [data-architecture]
---

# S32: RFC-001 core — identity, system home, namespace, `when`

<!-- DRAFT. Carrier for everything S30 deferred. Not started; no code.
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

- [ ] 1. Namespace (§4) — first, while it is still a text edit
  - [ ] 1.1 `namespace: z.string().optional()` replaces `project` + `environment`
    - **Depends**: — · **Requirements**: 2.1
  - [ ] 1.2 Collapse the pair-keyed sites and the generated-values key from 4-tuple to 3-tuple
    - **Depends**: 1.1 · **Requirements**: 2.2
  - [ ] 1.3 Namespace into container/network/ingress identity, with `dnsSafe()`
    - **Depends**: 1.2 · **Requirements**: 2.3
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

- [ ] 4. `when` (§5)
  - [ ] 4.1 `installedApps` replaces `activeApps`; delete `discoverRunningApps` — SIX sites
    - ⚠️ I6: two of them are in `apps/web`. One private commit, then cherry-pick.
    - **Depends**: — · **Requirements**: 3.1
  - [ ] 4.2 Use the full declared set, not the invocation's target set; needs a test
    - **Depends**: 4.1 · **Requirements**: 3.1
  - [ ] 4.3 `whenClauseLabel()` and the "Overlay skipped" warning say *installed*
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

## Log

**2026-08-31** — Created DRAFT as S30's deferral carrier. Numbered 32 because S31 is the
private queue's `S31-alpha-remainder` and the two queues share one number sequence.
