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
| **A. Make the account rootless-capable** | allocate subuid/subgid ranges and give it a home under the tree | D-6 says "no home"; this softens it. Rootless podman also cannot bind :80/:443 without extra config |
| **B. Grant it the rootful socket** | ACL or group on `/run/podman/podman.sock` | keeps D-6 intact, but hands a no-login account root-equivalent control of the host's containers |
| **C. Run the unit as root** | drop `User=` on podman hosts | simplest; abandons the reason the service account exists |

**A** is the most faithful to D-6's intent and the most work. **B** is what the docker path
already does in spirit (the `docker` group is likewise root-equivalent). **C** is a retreat.

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
  - [ ] 2.2 A `doctor` check that fails before `server start` does
    - **Depends**: 2.1 · **Requirements**: 2.2 · **Pillar**: Test
  - [ ] 2.3 Say what it grants, where the D-6 model is documented
    - **Depends**: 2.1 · **Requirements**: 1.2 · **Pillar**: Docs
- [ ] 3. Verify on a real host, by hand and through the unit
  - [ ] 3.1 On appbay-rhel (podman) and a docker host
    - **Depends**: 2.1 · **Requirements**: 1.3 · **Pillar**: Test
