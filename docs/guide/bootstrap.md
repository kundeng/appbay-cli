---
title: "Bootstrap Guide"
description: "From a single compiled binary to a working Appbay deployment — doctor, init, init-system, setup, and your first app."
---

# Bootstrap Guide

This guide walks a fresh host from "one compiled binary in hand" to a working
Appbay deployment. It is written for both human and AI operators: every step
has the exact command, the expected output, and the failure modes you are
likely to hit.

The journey is:

```
binary in hand
   │
   ▼
appbay doctor        verify the environment can run Appbay
   │
   ▼
appbay init-system   (RHEL-family hosts) install Docker + appbay user
   │
   ▼
appbay init          scaffold $APPBAY_HOME, shared network, system apps
   │
   ▼
appbay setup         configure the edge (ingress + auth), deploy system apps
   │
   ▼
appbay up <app>      deploy your first app
```

## 0. Prerequisites

Appbay ships as a single compiled binary — no Node.js, Bun, or other runtime is
needed on the target machine. You need:

| Requirement | Minimum | Check |
|-------------|---------|-------|
| Linux (x64/arm64) or macOS | — | `uname -m` |
| Docker **or** Podman | Docker 24.0+ / Podman 4.9+ | `docker --version` |
| Compose v2 | v2.23.1+ | `docker compose version` |

Compose v2.23.1+ is required because Appbay uses the `configs` resource with
inline `content`, introduced in that release.

### 0a. Installing the runtime — Docker

⚠️ **AppBay does not install this for you.** It consumes a runtime an administrator (or
external automation) has already configured. AppBay never installs packages, invokes
`sudo`, or mutates host services and firewall policy; `appbay doctor` reports what is
missing and names the repair step, and stops there.

Measured on Ubuntu 24.04 (Docker 29.1.3, Compose v2.40.3):

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER"      # log out and back in for this to take effect
sudo systemctl enable --now docker
```

### 0b. Installing the runtime — rootful Podman

Measured on Ubuntu 24.04 (Podman 4.9.3, podman-compose 1.0.6):

```bash
sudo apt-get update
sudo apt-get install -y podman podman-compose
sudo systemctl enable --now podman.socket   # rootful socket at /run/podman/podman.sock
```

Then tell AppBay which client to invoke:

```bash
appbay init --container-runtime podman
```

::: {.callout-note}
## `container_runtime` selects the CLIENT BINARY, not the daemon
`docker` here can perfectly well be talking to a rootful `podman.socket` via `DOCKER_HOST`
— that is the documented and often preferable arrangement, since podman's own man page
notes `docker-compose` takes precedence as a compose provider when installed. Choose
`podman` only when you want the `podman` binary itself invoked.
:::

### 0c. Verify the runtime by CREATING A CONTAINER

🚨 **A version banner is not proof the runtime works.** Measured: podman 6.0.2 with
docker-compose v5.1.2 prints its version happily and then fails `up` with `no such image`
on an image podman is holding. That reproduces with `podman compose` directly, with AppBay
uninvolved.

```bash
docker run --rm hello-world          # or: sudo podman run --rm quay.io/podman/hello
```

If that does not print a success message, stop here. Nothing below will work, and the
failure will surface later as something that looks like an AppBay bug.

### 0d. Ports, DNS, and firewall

| Expectation | Why |
|---|---|
| **:80 and :443 free** | The edge binds both. One host runs exactly ONE edge — Traefik *or* Caddy — because they cannot share those ports. |
| A wildcard DNS record, or hosts entries | `*.your.domain` must reach this host. For a local TLD, per-client `/etc/hosts` entries work. |
| Outbound 443 for ACME | Only if you want real certificates. A local TLD uses a self-signed wildcard cert instead and needs no outbound access. |

⚠️ If something else already holds :80 or :443, the edge container **starts and immediately
exits**, and `compose up -d` reports success for that — it started a container, it does not
wait to see whether it stays up. Check first:

```bash
sudo ss -tlnp | grep -E ':80 |:443 '
```

## 1. `appbay doctor` — verify the environment

`doctor` runs every prerequisite and health check and reports pass/fail per
check with an actionable fix for each failure. It is the first thing to run on
a fresh host.

```bash
appbay doctor
```

Expected output (healthy host):

```
Appbay Doctor

  ✓ Platform
    Linux (Docker Engine)
  ✓ Docker
    Docker version 29.4.0, build 9d7ad9f
  ✓ Docker service
    server v29.4.0
  ✓ Docker Compose v2
    v5.1.2
  ✓ Compose >= 2.23.1
    v5.1.2
  ✓ APPBAY_HOME
    /home/appbay/.appbay
  ✓ appbay_shared network
    exists
  ✓ Shared network DNS
    container on appbay_shared resolved a sibling by name
  ✓ Healthcheck start_period
    no known-slow app has an undersized start_period
  ...
  All required checks passed.
```

### Machine-readable output

For AI operators and automation, `doctor --json` emits a flat envelope:

```bash
appbay doctor --json
```

```json
{
  "ok": false,
  "checks": [
    { "name": "Docker", "passed": true, "detail": "Docker version 29.4.0", "required": true },
    { "name": "APPBAY_HOME", "passed": false, "detail": "/home/appbay/.appbay does not exist", "fix": "Run \"appbay init\" to create the Appbay home directory", "required": true }
  ]
}
```

`ok` is `true` only when every **required** check passed. Optional checks (GPU,
vault, server, SOPS, etc.) do not affect `ok` — they are advisory.

### Failure modes

- **`Docker not found`** — the container runtime is not installed. On a
  RHEL-family host, run `appbay init-system` (step 2) to install it.
- **`Docker service not responding`** — the daemon is installed but not
  running. Start it: `sudo systemctl start docker`.
- **`Docker daemon is up but the current user cannot reach it without sudo`**
  — the daemon is running, but your user is not in the `docker` group (rootful
  Docker). The fix is group membership, **not** running appbay under sudo:
  `sudo usermod -aG docker $USER`, then log out and back in. `appbay
  init-system` does this for you.
- **`APPBAY_HOME does not exist`** — expected on a fresh host; run `appbay
  init` (step 3).
- **`appbay_shared network not found`** — run `appbay init` to create it.
- **`Shared network DNS` failed** — a container on the shared network could not
  resolve a sibling by name. Recreate the network: `docker network rm
  appbay_shared`, then `appbay init`.

### The sudo question, once

There are **two deployment models**, and the identity answer differs:

| Model | Who runs appbay | Why | What appbay must NOT do |
|-------|-----------------|-----|------------------------|
| **Standalone host** (`appbay init-system`) | the operator's user, no sudo | `init-system` adds the user to the container group | create system accounts / set ACLs (that's `init-system`'s one-time job) |
| **DGX fleet** (Ansible) | root, via Ansible `become: true` | Ansible drives it; the tree is owned by the `llmsvc` service account (uid 950) | create system accounts / set ACLs — Ansible creates the D-6 uid model, appbay consumes it as data |

The rule that holds in **both** models is not "never sudo" — it is that **appbay
never creates system accounts or sets ACLs**. That is Ansible's job on the
fleet, and `init-system`'s one-time job on a standalone host. Folding uid/ACL
creation into the CLI would escalate the whole tool.

So the two things `doctor` checks are:

1. **Is the container binary installed?** (`docker --version`) — no daemon, no
   sudo.
2. **Can the current user reach the daemon without sudo?** (`docker info`) —
   this is where sudo would otherwise creep in.

If check 2 fails because the daemon needs sudo, the fix is to join the
container group (`sudo usermod -aG docker $USER` + re-login), which is exactly
what `appbay init-system` sets up on a standalone host. On an Ansible-managed
fleet, Ansible arranges access.

## 2. `appbay init-system` — host bootstrap (RHEL-family)

`init-system` is a **standalone-host convenience** for a single binary on a
fresh box. It installs Docker, creates the `appbay` user/group, adds `appbay`
to the docker group, and sets ACLs on `$APPBAY_HOME`.

> **Boundary:** For the DGX fleet, **ansible is authoritative**. `init-system`
> is tested to work, but the fleet path is ansible substrate, not this command.
> It is RHEL-family-first (matches prod); Debian-family and other distros are
> detected but not bootstrapped.

Preview what would change without touching the host:

```bash
appbay init-system --dry-run
```

```
Appbay init-system

  Distro: Rocky Linux 9.4 (rhel)

  Dry run — would make these changes:

  • Install Docker Engine (dnf)
    sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  • Enable + start docker.service
    sudo systemctl enable --now docker
  • Create appbay user + group
    sudo useradd --create-home --user-group --shell /bin/bash appbay
  • Add appbay to docker group
    sudo usermod -aG docker appbay
  • Set ACLs on /home/appbay/.appbay for appbay
    sudo setfacl -R -m u:appbay:rwX /home/appbay/.appbay

  No changes made.
```

Apply it (requires sudo):

```bash
appbay init-system
```

The command is **idempotent**: re-running it after a successful bootstrap
reports `Host is already bootstrapped. Nothing to do.` Each step detects the
current state and only changes what differs.

### Failure modes

- **`Unsupported distro family "debian"`** — `init-system` is RHEL-family-first.
  Install Docker manually, or use the ansible substrate for the DGX fleet.
- **`sudo: setfacl: command not found`** — the `acl` package is absent on a
  minimal image. `init-system` falls back to `chown -R appbay:appbay` on the
  home directory automatically.

## 3. `appbay init` — scaffold APPBAY_HOME

`init` creates the `$APPBAY_HOME` directory structure, the shared Docker
network, seeds system-app definitions, and writes the server compose file. It
is idempotent and resumable.

```bash
appbay init --project homelab --domain homelab.example.com --yes
```

`init` runs a **preflight gate** first: it verifies the environment-level
required checks (runtime present, service reachable, Compose v2, Compose
version). If any fails, it prints the failures + fixes and aborts:

```
Preflight check failed — cannot initialize Appbay:

  ✗ Docker
    Docker not found
    Fix: Install Docker: https://docs.docker.com/engine/install/  (or run "appbay init-system" on a RHEL-family host to install it)

Appbay runs as your user, not root. If a check says the daemon needs sudo,
add your user to the container group (or run "appbay init-system") rather
than running appbay under sudo.

Fix the issues above, then re-run. Or use --force to continue anyway.
```

Use `--force` to skip the gate and continue anyway (not recommended — a host
without Docker cannot run Appbay).

### Options

| Flag | Purpose |
|------|---------|
| `--dir <path>` | custom APPBAY_HOME (default `~/.appbay`) |
| `--project <name>` | project name |
| `--domain <name>` | base domain for ingress routing |
| `--container-runtime <docker\|podman>` | container binary to invoke |
| `--ingress-provider <traefik\|caddy>` | reverse proxy to emit config for |
| `--refresh-system-apps` | replace drifted system-app files (.bak kept) |
| `--force` | skip the preflight gate |

### Failure modes

- **Preflight gate aborts** — fix the reported environment issue, or pass
  `--force`. See the `doctor` failure modes above.
- **`Docker network "appbay_shared" already exists`** — expected on re-init;
  `init` is idempotent.

## 4. `appbay setup` — configure the edge and deploy system apps

`setup` is the guided wizard. It calls `init` internally, then initializes the
secrets vault and deploys the selected edge (Traefik or integrated Caddy
Security).

```bash
appbay setup
```

For scripting or CI, pass all options as flags:

```bash
appbay setup --domain homelab.example.com --project homelab --ingress-provider caddy --yes
```

At the end it prints bootstrap credentials for the admin user.

## 5. Deploy your first app

Appbay ships with a `whoami` starter app:

```bash
appbay up whoami
```

Verify it:

```bash
curl http://localhost:8888
```

You should see the container's hostname and request headers printed back.

## Full non-interactive journey (AI operator)

For an AI operator driving a fresh RHEL-family host end-to-end without prompts:

```bash
appbay doctor --json          # verify environment; fix required failures
appbay init-system            # install Docker + appbay user (sudo)
appbay init --project homelab --domain homelab.example.com --yes
appbay setup --domain homelab.example.com --project homelab --ingress-provider caddy --yes
appbay up whoami
```

Check the result with `appbay doctor --json` again — `ok` should be `true`.

## Related

- [Quickstart](quickstart.qmd) — the shorter, interactive path.
- [CLI reference](cli.qmd) — every command and flag.
- [Traits](traits.qmd) — the ingress/auth trait system (provider-agnostic).
