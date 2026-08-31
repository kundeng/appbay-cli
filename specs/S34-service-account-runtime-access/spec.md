---
spec_id: S34-service-account-runtime-access
status: DRAFT
closed_as: null
since: 2026-08-31
until: null
epic: platform
features: [service-account-runtime-access]
supersedes: []
superseded_by: null
depends_on: [S33-systemd-unit-and-tier2]
anchors: [data-architecture]
---

# S34: the D-6 service account cannot reach the container runtime

<!-- DRAFT. One decision, proven in probe-87. Activate once the owner has picked a direction. -->

# 1 · Requirements

## Introduction

🚦 **This sprint is one owner decision with three defensible answers.** It is written down
rather than guessed at because each answer changes what the D-6 ownership model *means*.

`appbay init-system --owner service` — the default — creates a no-login system account and
enables the container runtime. On a podman host the account it creates cannot run podman at
all, so `appbay server start` fails and the systemd unit S33 ships fails with it. Measured on
Fedora 43, probe-87:

```
sudo -u appbay podman info
  cannot resolve /home/appbay: lstat /home/appbay: no such file or directory   # --no-create-home

sudo -u appbay env HOME=/var/lib/appbay podman info
  no subuid ranges found for user "appbay" in /etc/subuid                      # rootless needs them

grep -c appbay /etc/subuid /etc/subgid
  0 / 0
```

⚠️ **Not a systemd problem.** `appbay server start` run by hand as that account fails the same
way (`EACCES: permission denied, posix_spawn 'podman'`). The same host runs the stack fine as an
ordinary user.

⚠️ **Docker hosts are probably fine** and that asymmetry is the clue: `init-system` adds the
account to the `docker` group, and rootful podman's socket is root-owned with no equivalent
group. `init-system`'s own comment says the control plane needs the ROOTFUL podman socket —
nothing currently grants the account access to it.

## The three answers

| | what it means | cost |
|---|---|---|
| **A. Make the account rootless-capable** | allocate subuid/subgid ranges | D-6 says "no home"; rootless podman also cannot bind :80/:443 without extra config |
| **B. Grant it the rootful socket** | ACL or group on `/run/podman/podman.sock` | keeps D-6 intact, but hands a no-login account root-equivalent control of the host's containers |
| **C. Run the unit as root** | drop `User=` on podman hosts | simplest; abandons the reason the service account exists |

## 🚦 probe-88 narrowed this after the spec was written

Isolating the two causes shows they are **separable**, and only one is a decision:

- **`$HOME` is not a decision.** It fails BEFORE podman attempts a connection, so it defeats
  the rootful path too — probe-87 read it as a rootless problem and it is not. It is machine
  state for a service account, it can live inside the tree the account already owns, and it
  grants nothing. Required under A, B and C alike.
- **subuid ranges are needed only for A.**
- **With `HOME` set, the rootful path reaches a connection attempt** against a
  `srw-rw---- root root` socket. As root with the identical environment the same command
  succeeds (`Version: 5.6.2`), so the only remaining barrier there is socket **permission**.

⇒ **B is parity with what `init-system` already does on docker**, not a new grant: the docker
path runs `usermod -aG docker` against a `root:docker 0660` socket unconditionally. It is still
the owner's call because it IS root-equivalent container control — but the question is now
"match docker, or deliberately diverge", not "choose between three philosophies".

## Requirements

### Requirement 1: the documented bootstrap actually reaches a running control plane

1.1 WHEN an operator runs `appbay init-system` then `appbay init` then `appbay server start` on
    a podman host, THE control plane SHALL start.
1.2 THE chosen mechanism SHALL be stated where the D-6 model is described, including what it
    grants the account — B and C both widen its privilege and must say so.
1.3 THE result SHALL be verified on a real host, both by hand and through the systemd unit.

### Requirement 2: docker and podman are not silently different

2.1 WHERE the two runtimes need different treatment, `init-system` SHALL do the right one per
    runtime rather than the docker one everywhere.
2.2 WHEN the account cannot reach the runtime, `appbay doctor` SHALL say so before
    `server start` fails — the current failure surfaces only at start time.

## Out of Scope

- Everything S33 shipped: the unit, the tier-2 narrowing, the RFC 2.7 refutation.
- Rootless podman for the deployed APPS. This is about the control plane's own access.

---

# 2 · Design

To be written at activation, after the owner picks A, B or C.

# 3 · Tasks

<!-- [ ] pending | [x] done | [!] BLOCKED: reason | [-] DROPPED: <reason> | [>] → <spec_id> -->

- [ ] 1. Pick a direction
  - [!] 1.1 BLOCKED — owner decision between A, B and C above. Proven in probe-87 with the
        exact commands and errors; nothing here is guesswork waiting on more investigation.
    - **Evidence**: `docs/rfc/evidence/probe-87-*.yaml`
- [ ] 2. Implement it in `init-system`, per runtime
  - [ ] 2.1 The mechanism itself
    - **Depends**: 1.1 · **Requirements**: 1.1, 2.1
  - [x] 2.2 A `doctor` check that reports it before `server start` does
    - ⚠️ Deliberately does NOT depend on 1.1. The check reports the CONDITION, which is the
      same under A, B and C; only the remedy differs. Blocking it on the decision would have
      left the session idle behind a task the decision does not actually gate.
    - 🚨 `checkDockerAccessible` answers for the CURRENT USER, and on a service install that is
      the wrong principal — the tree is owned by a no-login account the unit runs as, and the
      operator running `doctor` is somebody else. Doctor reported a healthy runtime while the
      account that mattered could not reach it; the failure surfaced later as `server start`
      exiting 1.
    - Reports **unknown, never pass**, when it cannot probe. `required: false`, because an
      operator install has no second account and a host without passwordless sudo is not broken.
    - 🚨 **The first version was wrong, and only running it showed that.** It probed with
      `sudo -n true`, but `tryExec` returns null when stdout is EMPTY even on exit 0
      (`.trim() || null`) — so it read "no passwordless sudo" on every host that has it and
      reported "cannot verify" always. The unit tests inject the probe and could not see it.
      Now `sudo -n id -un`.
    - Verified on appbay-rhel against ground truth: doctor prints
      `✗ appbay owns /var/lib/appbay but cannot reach podman — the control plane runs as
      appbay, not as you`, while `sudo -n -u appbay podman info` prints
      `cannot resolve /home/appbay`.
    - 8 tests on the decision (owner vs invoker vs probe result), plus the VM run for the
      plumbing the injected tests cannot cover.
    - **Requirements**: 2.2 · **Pillar**: Test, MVP
  - [ ] 2.3 Say what it grants, where the D-6 model is documented
    - **Depends**: 2.1 · **Requirements**: 1.2 · **Pillar**: Docs
- [ ] 3. Verify on a real host, by hand and through the unit
  - [ ] 3.1 On appbay-rhel (podman) and a docker host
    - **Depends**: 2.1 · **Requirements**: 1.3 · **Pillar**: Test
