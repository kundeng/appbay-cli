---
spec_id: S33-systemd-unit-and-tier2
status: DRAFT
closed_as: null
since: 2026-08-31
until: null
epic: platform
features: [systemd-unit, tier2-config-removal, system-config-merge]
supersedes: []
superseded_by: null
depends_on: [S32-rfc-001-core]
anchors: [data-architecture]
---

# S33: the systemd unit, and the config tier that needs it

<!-- DRAFT. Carrier for the two RFC-001 items S32 could not finish, both blocked on the same
     missing artifact: a systemd unit that exports APPBAY_HOME. -->

# 1 · Requirements

## Introduction

S32 closed RFC-001 except for two items, and they are the same item twice. RFC-001 **2.7** says
to delete `/etc/appbay/config` and `writeSystemConfig` **"after the systemd unit exports
`APPBAY_HOME`"**, and RFC-001 **2.1** asks for `InstanceConfigSchema` and `SystemConfig` to
become one file — but `SystemConfig` *is* `/etc/appbay/config`, so merging it away is the same
deletion wearing a different hat.

🚨 **Neither can land without writing the unit first, and that is not a formality.** The RFC is
explicit that tier 2's real job is outranking a per-operator `~/.config` choice on a service
install, and that `Environment=APPBAY_HOME=` in the unit covers it at tier 1. Delete the tier
without the unit and a service install silently starts resolving the home from whichever
account systemd happens to run as — a working mechanism removed with nothing in its place.

⚠️ S32 shipped the half of 2.1 that stands alone: the instance config moved to
`etc/system.yaml`, one reader, `init` migrates the legacy file. What is carried here is only the
`SystemConfig` merge.

**Read before starting:** `docs/rfc/RFC-001-consolidation.md` §2 (2.1 and 2.7),
`specs/S32-rfc-001-core/spec.md` tasks 2.1 and 2.4, and `packages/core/src/schemas/instance.ts`,
whose `home:` field exists to detect exactly the moved/copied-home failure this tier guards.

## Requirements

### Requirement 1: a service install resolves its home from the unit

1.1 THE project SHALL ship a systemd unit for the control plane that sets
    `Environment=APPBAY_HOME=<path>`.
1.2 WHEN the unit is installed, THE resolution order SHALL reach the correct home at tier 1
    without consulting `/etc/appbay/config`.
1.3 THE unit SHALL be verified on a real service start, not by reading it — S32's record is
    that every defect beyond the RFC's list was invisible to reading and to `tsc`.

### Requirement 2: tier 2 goes only once tier 1 covers it

2.1 THE system SHALL delete `/etc/appbay/config` and `writeSystemConfig` **after** 1.1 lands.
2.2 THE `SystemConfig` type SHALL be merged into `InstanceConfigSchema` / `etc/system.yaml`, or
    deleted outright if nothing survives the merge.
2.3 WHEN an installation still has `/etc/appbay/config`, THE upgrade SHALL say what it read from
    it and where that setting now lives — an operator whose home moves silently is the failure
    this whole tier exists to prevent.

### Non-Functional

- **NF 1** — Every commit is one-sided; `check-straddle.mjs` exits 0.
- **NF 2** — `check-server-compose.mjs` keeps the harness and the embedded template aligned; a
  unit that disagrees with either is a third copy of the same topology.

## Out of Scope

- Everything RFC-001 shipped in S30 and S32.
- RFC-001 **4.6** (`${{namespace.KEY}}` value loader) — **decided against**, not deferred. See
  S32 task 1.2b: `namespace:` is a per-app label with no variable store, and `${{project.KEY}}`
  reads the per-host installation config. They shared a word, not a concept.
- RFC-001 **6.3** (extract the UOM stack into its own repo) — a different repository.

---

# 2 · Design

To be written at activation. The sequencing is fixed and is the RFC's: unit first, deletion
second. Do not reverse it to "clean up" the config tier before its replacement exists.

# 3 · Tasks

- [ ] 1. Write and verify the systemd unit
  - [ ] 1.1 The unit file, with `Environment=APPBAY_HOME=`
    - **Requirements**: 1.1, 1.2 · **Pillar**: Packaging, MVP
  - [ ] 1.2 Verify on a real service start on a VM, including a home the invoking user does
        not own — the case tier 2 was protecting
    - **Depends**: 1.1 · **Requirements**: 1.3 · **Pillar**: Test
- [ ] 2. Retire tier 2
  - [ ] 2.1 Delete `/etc/appbay/config` and `writeSystemConfig`
    - **Depends**: 1.2 · **Requirements**: 2.1
  - [ ] 2.2 Merge or delete `SystemConfig`
    - **Depends**: 2.1 · **Requirements**: 2.2
  - [ ] 2.3 Report what was read from a legacy tier-2 file and where it moved
    - **Depends**: 2.1 · **Requirements**: 2.3 · **Pillar**: Docs
