---
spec_id: S33-systemd-unit-and-tier2
status: CLOSED
closed_as: FORK-FORWARD
closed: 2026-08-31
since: 2026-08-31
activated: 2026-08-31
until: null
epic: platform
features: [systemd-unit, tier2-config-narrowing, system-config-merge]
supersedes: []
superseded_by: S34-service-account-runtime-access
depends_on: [S32-rfc-001-core]
anchors: [data-architecture]
---

# S33: the systemd unit, and the config tier that turns out not to need it

<!-- DRAFT. Carrier for the two RFC-001 items S32 could not finish, both blocked on the same
     missing artifact: a systemd unit that exports APPBAY_HOME. -->

# 1 · Requirements

## Introduction

S32 closed RFC-001 except for two items, and they are the same item twice. RFC-001 **2.7** says
to delete `/etc/appbay/config` and `writeSystemConfig` **"after the systemd unit exports
`APPBAY_HOME`"**, and RFC-001 **2.1** asks for `InstanceConfigSchema` and `SystemConfig` to
become one file — but `SystemConfig` *is* `/etc/appbay/config`.

## 🚨 The first thing this sprint did was disprove its own premise

**RFC 2.7 is unsound as written, and the check that shows it is three commands** — probe-86,
measured on `appbay-docker` (Ubuntu 24.04, systemd 255) with the real binary:

| | sees `APPBAY_HOME` from a unit's `Environment=` |
|---|---|
| the **service** systemd starts | `/var/lib/appbay` |
| an operator's **login shell** | `<unset>` |
| a **non-login** shell | `<unset>` |

A unit sets the environment of the processes *it* starts. Tier 2 exists for the opposite
process tree — an operator typing `appbay …` — and it demonstrably does that job:

```
/etc/appbay/config    home: /var/lib/appbay
~/.config/appbay/home       /home/ubuntu/appbay-personal

appbay home  ->  /var/lib/appbay              # host truth wins
sudo rm /etc/appbay/config
appbay home  ->  /home/ubuntu/appbay-personal # ⇐ the exact failure tier 2 prevents
```

That last line is verbatim what the RFC says the tier is for: *"outranking a per-operator
`~/.config` choice on a service install"*. The unit cannot substitute for it, so writing the
unit does not license the deletion. **The sequencing in RFC 2.7 rests on the two being
interchangeable, and they are not.**

⇒ **This sprint keeps tier 2 and narrows it.** It still ships the unit, because running the
control plane under systemd is right on its own merits — just not as the prerequisite for a
deletion it cannot cover.

## Two more things the audit turned up

- **AppBay ships no systemd unit at all today.** `init-system` enables the *container
  runtime's* unit (`podman.socket`, or `docker`) and writes none of its own. Its module header
  claims it "installs systemd units" — stale, and the kind of claim that makes a reader think
  the prerequisite already exists.
- **`SystemConfig.owner` and `.service_user` are write-only.** `init-system` writes them;
  `readSystemConfig()` has exactly two callers and both read only `.home`. The "handshake" the
  module header describes — `init-system` records the decision, `init` reads it — does not
  happen. The ownership decision still has real effects (chown, ACLs, the service account), but
  they are applied at `init-system` time and recorded in the filesystem, not read back.

**Read before starting:** `docs/rfc/evidence/probe-86-*.yaml`,
`docs/rfc/RFC-001-consolidation.md` §2 (2.1 and 2.7), and
`apps/cli/src/utils/appbay-home.ts`, which is the resolution order itself.

## Requirements

### Requirement 1: the control plane runs under systemd

1.1 THE project SHALL ship a systemd unit for the control plane that sets
    `Environment=APPBAY_HOME=<path>`, installed by `init-system`.
1.2 THE unit SHALL be verified on a real service start, not by reading it — S32's record is
    that every defect beyond the RFC's list was invisible to reading and to `tsc`.
1.3 THE unit SHALL NOT be described as making `/etc/appbay/config` removable (probe-86).

### Requirement 2: tier 2 stays, and carries only what is read

2.1 THE system SHALL KEEP `/etc/appbay/config` in the resolution order. Requirement changed
    from RFC 2.7 on the evidence in probe-86; the RFC's own justification for the tier is the
    behaviour that breaks without it.
2.2 THE system SHALL drop the write-only `owner` and `service_user` fields, OR give them a
    reader. A field written and never read is a claim the code does not keep.
2.3 WHEN `init-system` describes what it installs, THE description SHALL match what it does.

### Requirement 3: RFC-001's record reflects what was measured

3.1 THE RFC's 2.7 SHALL be annotated with probe-86's result rather than left as an open item a
    later reader would try to implement.

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

<!-- [ ] pending | [x] done | [!] BLOCKED: reason | [-] DROPPED: <reason> | [>] → <spec_id> -->

- [x] 0. Check the design before building to it
  - [x] 0.1 probe-86 — a unit's `Environment=` reaches the service and nothing else
    - Disproves RFC 2.7's premise. Measured on appbay-docker with the real binary: service
      `/var/lib/appbay`, operator login shell `<unset>`, and deleting `/etc/appbay/config`
      makes the CLI resolve a personal `~/.config` path over the service install.
    - Also found: appbay ships no unit at all, and `owner`/`service_user` are write-only.
    - **Pillar**: Design, Test · **Evidence**: `docs/rfc/evidence/probe-86-*.yaml`

- [x] 1. Say what is true about systemd today
  - [x] 1.1 Fix `init-system.ts`'s "installs systemd units" — it enables the runtime's unit
    - It writes none of its own; the only unit touched is `podman.socket` / `docker`, and it is
      enabled rather than written. The claim mattered because a reader could conclude RFC 2.7's
      prerequisite already existed.
    - **Depends**: 0.1 · **Requirements**: 2.3 · **Pillar**: Docs
  - [x] 1.2 Annotate RFC-001 2.7 with probe-86 so a later reader does not implement it
    - Struck through in the RFC with the measurement inline, not silently dropped — the RFC is
      the decision record, and an item that looks open is one somebody will implement.
    - **Depends**: 0.1 · **Requirements**: 3.1 · **Pillar**: Design, Docs

- [x] 2. Narrow tier 2 to what is actually read
  - [x] 2.1 Drop `owner` / `service_user` from `SystemConfig`
    - Dropped rather than given a reader: the ownership decision's real record is the file
      ownership and POSIX ACLs `init-system` sets on the tree, where it is observable and
      cannot drift. A second copy in /etc could only disagree with the filesystem, and a stale
      one is worse than none.
    - 🚨 **A live bug fell out.** `owner` was VALIDATED on read — an unrecognised value made
      the whole file parse to `null`, so the CLI fell through to the per-operator
      `~/.config/appbay/home` and silently resolved a different installation. A typo in a field
      nothing consumed could move an operator's entire tree. Unknown keys are now ignored.
    - Backward compatible by construction: every host that ran the older `init-system` still
      has `owner:`/`service_user:` lines, and they must keep resolving. Pinned by two tests,
      including the `owner: bogus` case that used to return null.
    - **Depends**: 0.1 · **Requirements**: 2.2 · **Pillar**: MVP, Test
  - [x] 2.2 Correct `system-config.ts`'s header — it described a handshake that does not happen
    - **Depends**: 2.1 · **Requirements**: 2.3 · **Pillar**: Docs
  - [x] 2.3 Sweep the docs the §1 cutover left behind
    - Found while checking this: `production.qmd` still told operators to harden "the admin
      account created during first-run setup", and `api-endpoints.qmd` documented
      `auth.setupRequired` and `auth.rotateSession`, both deleted.
    - ⚠️ **This task was marked done and was not.** A close-out audit found the auth router's
      INTRO sentence still naming `auth.rotateSession` — my sweep had matched `### ` headings
      and missed prose — and, worse, that the Python slice which removed those two sections had
      also deleted the whole `## edge` section.
    - 🚨 **And I had validated it in the wrong tree.** `check-docs-cli`'s router check is
      guarded by `existsSync("apps/web/…")`, which is PRIVATE-only, so running it from the
      public tree skips it entirely and reports ✓. Same false-pass shape as S32 task 3.1's
      stale `packages/core/dist`. Gates that are inert in one tree must be run in the other.
    - **Pillar**: Docs
  - [x] 2.4 Make the gate catch it, since a manual sweep missed the same thing twice
    - `check-docs-cli` compared ROUTERS only: a documented procedure that no longer exists
      sailed through. It now checks that direction too, matching anywhere in the prose rather
      than only in `### ` headings — restricting it to headings is exactly how the second
      occurrence got through.
    - A tombstone may still name what it buries, via an explicit
      `<!-- removed: auth.rotateSession -->`. Deliberately noisy, so "documented" and
      "documented as gone" cannot be confused, and deleting the tombstone re-arms the check.
    - Proven to discriminate both ways: naming a nonexistent procedure fails it; removing the
      tombstone marker re-arms it on the two real removals; restoring passes.
    - **Pillar**: Test, Docs

- [x] 3. Ship the unit, on its own merits
  - [x] 3.1 An `appbay-server.service` unit with `Environment=APPBAY_HOME=`, installed by
        `init-system`
    - `Type=oneshot` + `RemainAfterExit=yes`, because `appbay server start` brings the stack up
      and exits — `Type=simple` would restart it forever.
    - Orders `After=`/`Wants=` the runtime, never `Requires=`: the latter propagates a stop, so
      restarting docker would take the control plane down with it.
    - `Environment=APPBAY_HOME=` is still load-bearing, for a different reason than the RFC
      gave: systemd starts services with almost no environment, so without it the unit would
      fall through the tiers to `~/.appbay` of whoever it runs as.
    - Written, NOT enabled. Starting a control plane at boot is the operator's decision; the
      summary prints the one command.
    - 11 tests, each pinning a runtime failure mode rather than a format detail.
    - **Depends**: 1.1 · **Requirements**: 1.1, 1.3 · **Pillar**: Packaging, MVP
  - [x] 3.2 Verify on a real service start on a VM
    - On appbay-rhel (Fedora 43, systemd 258): `systemd-analyze verify` exits 0; the unit
      correctly ordered after `podman.socket` and not a `podman.service` that does not exist;
      `systemctl start` runs ExecStart and reports failure legibly in the journal, naming the
      cause each time.
    - ✅ Also verified the S33 premise on a second host and distro: `appbay home`, run from
      `/tmp` by an ordinary user, resolved `/var/lib/appbay` through tier 2 — the property a
      unit cannot provide.
    - 🚨 **Found doing this: `appbay init` CRASHED for the service account `init-system`
      itself creates** — unhandled `EACCES: mkdir '/home/appbay'` with a raw bun stack trace,
      on the very step `init-system` prints as "Next". Fixed in task 3.3.
    - **Depends**: 3.1 · **Requirements**: 1.2 · **Pillar**: Test
  - [x] 3.3 Stop `saveAppbayHome` crashing on an account with no writable `$HOME`
    - `--owner service` creates the account `--no-create-home`, so `$HOME` is a `/home/<user>`
      that does not exist and cannot be created. The documented bootstrap path was broken for
      its own default ownership model.
    - Not merely a try/catch: writing tier 3 there is also POINTLESS, because tier 2 already
      records the home and outranks it. A per-operator copy could only be shadowed, or later
      disagree. Returns `saved` | `unnecessary` | `failed`; `appbay home set` still fails hard,
      because writing that pointer is the whole command.
    - **Depends**: 3.2 · **Pillar**: MVP, Test

- [x] 4. 🚦 The D-6 service account cannot run podman
        · [>] → S34-service-account-runtime-access
  - [>] 4.1 → S34. An owner decision between three defensible answers, not more investigation.
        Proven, with commands and errors, in probe-87:
    - `sudo -u appbay podman info` → `cannot resolve /home/appbay: lstat ... no such file`
      (`--no-create-home`), and with `HOME` set → `no subuid ranges found for user "appbay"`
      (`grep -c appbay /etc/subuid` = 0). Both are direct consequences of how `init-system`
      creates the account.
    - NOT a systemd problem: `appbay server start` by hand as that account fails the same way
      (`EACCES: permission denied, posix_spawn 'podman'`).
    - Docker hosts are likely unaffected — `init-system` adds the account to the `docker`
      group. Rootful podman's socket is root-owned and has no equivalent.
    - The choice is between giving the account subuid ranges and a home, granting it the
      rootful podman socket, or running the unit as root — each changes what the D-6 model
      means, so it is the owner's call rather than mine.
    - **Depends**: 3.2 · **Evidence**: `docs/rfc/evidence/probe-87-*.yaml`

---

# 4 · Close-out

Closed **FORK-FORWARD** 2026-08-31. Every task is done except the one that was never a build
task — the D-6/podman access decision, carried to `S34-service-account-runtime-access`.

## What this sprint was actually for, in the end

It was chartered to write a systemd unit so RFC-001 2.7's deletion could proceed. **It disproved
that.** The unit shipped anyway, on its own merits; the deletion did not, and the RFC now says so
with the measurement attached. A sprint whose first act invalidates its own premise is the
cheapest outcome available — the alternative was implementing 2.7 and finding out from an
operator whose installation moved.

## The three defects found by checking rather than by building

| | found by | would have surfaced as |
|---|---|---|
| `owner:` validated on read | reading the code the RFC pointed at | a typo in a dead field silently moving an operator's whole tree |
| `appbay init` crashes for the D-6 account | running the documented next step on a real host | a raw bun stack trace on the first command after `init-system` |
| a doc sweep deleted the `## edge` section | auditing "done" tasks against artifacts, not checkboxes | a router documented nowhere |

## The process lesson, which cost the most

`check-docs-cli`'s router half is guarded by `existsSync("apps/web/…")` — private-only — so
running it from the public tree skips it and prints ✓. I validated a doc change there and
shipped a deleted section. This is the same shape as S32 task 3.1's stale `packages/core/dist`.

⇒ **A gate that is inert in one tree proves nothing when run there.** Both trees, or neither.
The gate itself now also checks documented tRPC procedures against the routers, because a manual
sweep missed the same class of thing twice in one sprint.
