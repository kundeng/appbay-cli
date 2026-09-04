---
spec_id: S34-service-account-runtime-access
status: CLOSED
closed_as: SHIPPED
since: 2026-09-01
activated: 2026-09-01
closed: 2026-09-01
until: null
epic: platform
features: [service-account-runtime-access]
supersedes: []
superseded_by: null
depends_on: [S33-systemd-unit-and-tier2]
anchors: [data-architecture]
---

# S34: the D-6 service account cannot reach the container runtime

<!-- CLOSED / SHIPPED 2026-09-01. Owner picked B (rootful); implemented and verified end to end
     on appbay-rhel through a reboot (probe-90). One leftover with a real destination:
     the docker service install end to end → appbay-cli#8.

     ⭐ WHAT THIS SPRINT ACTUALLY COST, for whoever plans the next one. The decision was one
     line. Five defects stood between it and a serving control plane, and FOUR OF THEM WERE
     FOUND BY RUNNING THE DOCUMENTED ORDER ON A FRESH HOST, not by design or by tests:
       · init-system skipped ownership+ACLs because the home did not exist yet → the D-6
         install never reached a working state on ANY runtime
       · doctor asked podman for a docker field → reported "cannot reach" on a host that could
       · runtimeSocketFor chose the socket by `uid === 0` → mounted a rootless path that does
         not exist
       · dnf config-manager --add-repo is dnf4 → init-system could not install Docker on any
         current Fedora
     All four report CONFIDENTLY IN THE WRONG DIRECTION, and none is visible to a unit test:
     each is either an argv executed on a host or a condition about the host's own state. -->

# 0 · Outcome

`appbay init-system` → `appbay init --container-runtime podman --yes` →
`systemctl enable --now appbay-server.service`, on a genuinely fresh Fedora 43 host:

```
appbay.server   Up 26 seconds (healthy)
health HTTP 200
appbay   next-server (v16.2.4)        <- running as the service account
```

and after `systemctl reboot`, all three again, with the socket group and directory traversal
re-applied by systemd and tmpfiles without intervention.

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

## ✅ The decision — B, rootful only (owner, 2026-09-01)

> *"for now clearly support rootful for podman only. Too tricky to set everything right for a
> user space podman."*

**A is not merely harder — it cannot do the job.** The edge binds `80:80` and `443:443`
(`system-apps.ts`), and rootless podman cannot bind below 1024 without setting
`net.ipv4.ip_unprivileged_port_start` **host-wide**, which lowers the bar for every process on
the machine. That is a larger privilege change than granting one account one socket, so
"rootless is the safer option" does not survive contact with what appbay needs.

**And appbay already chose rootful.** `init-system.ts:316` enables `podman.socket` with its own
comment saying *"what the control plane needs is the ROOTFUL API socket"*. probe-87 did not find
an unmade decision; it found a decision that was never followed through — nothing granted the
account access to the socket that decision had already selected.

**What it costs, stated plainly:** the no-login account gets root-equivalent container control.
It already has exactly that on docker via `usermod -aG docker`. This is parity, not a
regression — what is forgone is a hardening appbay never had.

⇒ A is **dropped from the design**, not left open. Leaving it listed would present "rootless" as
a cautious alternative when the port constraint means it is not an alternative at all.

## 🚦 probe-89: B is THREE actions, and the obvious one is inert alone

Measured on appbay-rhel, one variable at a time. Each barrier alone blocks the account:

| | barrier | fix | grants privilege? |
|---|---|---|---|
| 1 | `$HOME` is `/home/appbay`, which `--no-create-home` never created | point the account's home at the tree it already owns | no |
| 2 | `/run/podman` is `drwx------ root root`, and the socket `root:root` | `SocketGroup=` drop-in **and** a tmpfiles override for the directory | **yes — this is the grant** |
| 3 | `podman` run by a non-root user defaults to **rootless** | `CONTAINER_HOST` in the execution environment | no |

🚨 **Barrier 3 is the one that would have been shipped broken.** With the socket granted and
`CONTAINER_HOST` absent, `podman` never touches that socket — it goes rootless and fails on
subuid exactly as before. `ls -l /run/podman/podman.sock` would show `root:appbay 0660` and the
work would look done. Only an end-to-end probe (`podman info` returning `5.6.2`) distinguishes
the two.

⚠️ **`DirectoryMode=` on the socket unit does not fix barrier 2** — it applies only when systemd
creates the parent directory, and here `/usr/lib/tmpfiles.d/podman.conf:15` created it first
(`D! /run/podman 0700 root root`). The tmpfiles override was verified to survive a reboot: the
directory came back `drwxr-x--- root appbay`, so the `z` line wins over the `D!` line at boot.

Also measured: `/etc/subuid` and `/etc/subgid` still hold **zero** appbay entries while the
probe returns `5.6.2` — confirming the rootful path needs none.

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

Everything below is **podman + `--owner service` only**. On docker the path is unchanged; on an
operator install there is no second account and nothing applies.

## One source of truth for the environment, because the probe and the runner must agree

The three barriers split across two artifacts that are written by different code:

```
                    barrier 2 (the grant)        barriers 1 + 3 (machine state + env)
                            │                                  │
   init-system ─────────────┤                                  ├──── systemd unit  (the runner)
                            │                                  │
                            │                                  └──── doctor probe  (the checker)
                            ▼                                        ▲
       podman.socket.d/10-appbay.conf                                │
       tmpfiles.d/zz-appbay-podman.conf         ← must use the SAME env as the runner
```

🚨 **`defaultProbeAs` (`checks.ts:492`) runs `sudo -n -u appbay podman info` with no
environment.** After this sprint's grant lands, that probe still exercises the **rootless** path
and would report `denied` on a correctly configured host — the doctor check S34 already shipped
would start lying in the opposite direction. This is the sprint's own instance of the recurring
bug class: *a check that answers a different question than the one asked.*

⇒ `packages/core/src/runtime/podman-rootful.ts` exports the environment **as data**, and both
consumers derive from it rather than each constructing it:

```ts
export const PODMAN_ROOTFUL_SOCKET = "/run/podman/podman.sock";
export function podmanRootfulEnv(home: string): Record<string, string>;
//   → { HOME: home, CONTAINER_HOST: `unix://${PODMAN_ROOTFUL_SOCKET}` }
```

The unit renders it as `Environment=` lines; the probe spreads it into the spawn. A test asserts
the two agree, so they cannot drift into the state above.

## init-system: three actions replacing one no-op

`init-system.ts:407` currently emits, on the podman path, an action whose label says the step
does not apply:

```ts apps/cli/src/commands/init-system.ts:408
      actions.push({
        id: "docker-group",
        label: `No group step for rootful Podman (no daemon socket group; see ${runtimeUnit})`,
        wouldChange: false,
        command: [],
      });
```

That was correct as an observation — there is no pre-existing podman group — and wrong as a
conclusion: the group has to be **created on the socket**, not found. It is replaced by:

| id | what it writes | why not something simpler |
|---|---|---|
| `podman-socket-group` | `/etc/systemd/system/podman.socket.d/10-appbay.conf` with `SocketGroup=<svc>` | a plain `setfacl` on the socket does not survive systemd recreating it on every socket start |
| `podman-runtime-dir` | `/etc/tmpfiles.d/zz-appbay-podman.conf` with `z /run/podman 0750 root <svc> -` | `DirectoryMode=` in the drop-in does not apply — tmpfiles created the directory first (probe-89) |
| `service-home` | `usermod -d <home> <svc>` | the account exists on hosts that already ran the old `init-system`, so `useradd --home-dir` alone would not repair them |

⚠️ **The tmpfiles file must NOT be named `podman.conf`.** A file of that basename in `/etc`
*shadows* `/usr/lib/tmpfiles.d/podman.conf` entirely, silently dropping its other lines (the
`/tmp/podman-run-*` and `/var/tmp/container_images*` cleanup). `zz-appbay-podman.conf` sorts
after it and only adds.

Both file-writing actions follow the existing step-7 pattern (`sh -c` with a heredoc via sudo),
and `podman-socket-group` is followed by `systemctl daemon-reload` + `systemctl restart
podman.socket` — without the restart the drop-in is on disk and the live socket is still
`root:root`.

## Where each requirement lands

- **1.1** — the three actions above, verified end to end by 3.1.
- **1.2** — 2.3 documents that the account gains root-equivalent container control, next to the
  existing docker-group statement, since it is the same grant.
- **2.1** — every new action is inside `if (runtimeIsPodman)`; docker keeps `usermod -aG docker`.
- **2.2** — shipped, but its probe must be corrected per the box above or it inverts.

# 3 · Tasks

<!-- [ ] pending | [x] done | [!] BLOCKED: reason | [-] DROPPED: <reason> | [>] → <spec_id> -->

- [x] 1. Pick a direction
  - [x] 1.1 **B — rootful only.** Owner, 2026-09-01. A is not a weaker option but a
        non-option: the edge binds `80:80`/`443:443` (`system-apps.ts:290`) and rootless podman
        cannot without a host-wide `net.ipv4.ip_unprivileged_port_start`. `init-system.ts:316`
        had already chosen the rootful socket; the gap was follow-through, not a missing choice.
        A is dropped rather than left open — see § The decision.
    - **Evidence**: `docs/rfc/evidence/probe-87-*.yaml`, `probe-88-*.yaml`
- [x] 2. Implement it in `init-system`, per runtime
  - [x] 2.1 The mechanism itself — three actions, per probe-89
    - 🚨 Barrier 3 (`CONTAINER_HOST`) makes barrier 2 inert if omitted, and the artifact looks
      correct either way. Verify with `podman info` returning a version, never with `ls -l`.
    - [x] 2.1a `podman-rootful.ts` — the environment as data, shared by unit and probe
    - [x] 2.1b `init-system`: socket drop-in, tmpfiles override, account home
    - [x] 2.1c `systemd-unit.ts`: `Environment=CONTAINER_HOST=` on podman service installs
    - [x] 2.1d `checks.ts`: `defaultProbeAs` uses the same environment, or it inverts
    - **Depends**: 1.1 · **Requirements**: 1.1, 2.1 · **Evidence**: `probe-89-*.yaml`
  - [x] 2.1e 🚨 **`init-system` creates `$APPBAY_HOME`** — found by running the documented
        order, not predicted. Steps 5 and 6 were both `if (existsSync(home))` and the home is
        created by the NEXT command in the sequence, so both printed "run appbay init first"
        and did nothing. `appbay init` (under sudo, because `init-system` needed it) then made
        the whole tree root-owned 0755 and nothing came back. **The D-6 install never reached a
        working state on any runtime.** Not podman-specific. The default ACLs are what make one
        pass enough: everything `init` creates inside inherits `u:appbay:rwx` regardless of who
        runs it.
    - **Requirements**: 1.1 · **Evidence**: `probe-90-*.yaml` · **Pillar**: MVP
  - [x] 2.1f 🚨 **`runtimeSocketFor` chose the mounted socket by `uid === 0`** — which answers
        "am I root", while the question is "which socket does this install use". S34 is exactly
        the change that made those different questions. The uid-950 account got
        `/run/user/950/podman/podman.sock` and the control plane died with `statfs: no such file
        or directory` on a host where every grant was correct. `CONTAINER_HOST` is now consulted
        first (`unix://` only — `tcp://`/`ssh://` mean the socket is not on this host).
    - **Requirements**: 1.1 · **Evidence**: `probe-90-*.yaml` · **Pillar**: MVP, Test
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
  - [x] 2.2b 🚨 **The probe asked podman for a DOCKER field.** `{{.ServerVersion}}` does not
        exist on `system.infoReport`; podman errors (exit 125), `tryExec` returns null, and the
        check reported `denied` on every podman host regardless of access. The design section
        above predicted this exact inversion and `podmanRootfulEnv` was built to prevent it —
        it shipped anyway, because unifying the ENVIRONMENT left the ARGV docker-shaped, and the
        unit tests assert the env. Caught only by running `doctor` against known ground truth.
    - **Requirements**: 2.2 · **Evidence**: `probe-90-*.yaml` · **Pillar**: Test
  - [x] 2.3 Say what it grants, where the D-6 model is documented
    - `docs/guide/bootstrap.md` §2: a table putting the docker group and the podman socket
      grant side by side as the same privilege class, an explicit statement that the account
      gets root-equivalent container control either way, and why rootless is not an option
      (`:80`/`:443`). Its dry-run sample had also drifted to a `useradd` this command has not
      issued for some time; corrected to real output. Four failure modes added, all measured.
    - **Depends**: 2.1 · **Requirements**: 1.2 · **Pillar**: Docs
- [x] 3. Verify on a real host, by hand and through the unit
  - [x] 3.1 On appbay-rhel (podman) — full documented order from a genuinely fresh host
    - `init-system` → `init --container-runtime podman` → `systemctl enable --now
      appbay-server.service` → container `Up (healthy)` → `health HTTP 200`, with the server
      process running as `appbay`. **Survives a reboot**: unit active, socket `root:appbay`,
      `/run/podman` `drwxr-x---`, HTTP 200 again.
    - **Depends**: 2.1 · **Requirements**: 1.3 · **Pillar**: Test · **Evidence**: `probe-90-*.yaml`
  - [x] 3.2 🚨 **`init-system` could not install Docker on any current Fedora** — found by
        trying to run the docker branch. `dnf config-manager --add-repo` is dnf4 syntax and
        dnf5 (Fedora 41+) rejects it outright, after which every package is "No match for
        argument". Purely syntax: Docker ships an fc43 build. `dnfMajorVersion()` now picks
        `addrepo --from-repofile=` on dnf5 and keeps `--add-repo` for EL8/EL9.
    - ⚠️ **No test can catch this class.** The action is DATA — an argv assembled into a plan
      and executed by sudo on a host. A unit test can only assert the argv matches what the
      author believed. The instrument is running the branch on the distro.
    - **Requirements**: 2.1 · **Evidence**: `probe-91-*.yaml` · **Pillar**: MVP
  - [>] 3.3 The docker SERVICE install end to end → **appbay-cli#8**
    - `init-system` is RHEL-family-only and refuses on the Ubuntu docker VM by design; the RHEL
      VM has no docker and installing it would compromise the podman host this sprint's evidence
      rests on; `multipass find` lists no RHEL-family image. Everything S34 CHANGED is
      runtime-independent and is verified end to end in 3.1; the docker-specific branch
      (`usermod -aG docker`) is untouched and was checked at plan level only.
    - **Requirements**: 1.3 · **Pillar**: Test
