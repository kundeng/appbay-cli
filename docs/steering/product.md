# Product

## What appbay is

An open-source control plane for Docker Compose applications on a self-hosted machine,
running on Docker or Podman. An operator installs one binary, initialises a home
directory, and installs apps from a catalog of 150-plus entries. Each app is its upstream
`docker-compose.yml` plus an `appbay.yaml` beside it. The manifest declares traits
(ingress, GPU, auth, hooks, backup, secrets, scoped env), a namespace, and conditional
overlays; the compiler turns the pair into the compose file that runs, and the deploy path
converges it and installs its edge route. A web control plane, in a separate repository,
drives the same core.

Published at `github.com/kundeng/appbay-cli`, installed with one `curl | sh`, MIT-licensed.
The audience is anyone running a home lab or a small server who wants Compose apps with
routing, secrets and identity handled for them, on either container runtime, without
Kubernetes.

## Who it is for

| user | wants |
|---|---|
| a self-hosting operator | `appbay install <app>` then `appbay up <app>` and a working `https://<app>.<domain>`, on Docker or Podman, with secrets never on disk in the clear |
| a catalog author | to package an upstream Compose app with a short `appbay.yaml` and have traits do the rest |
| a contributor | a codebase where one question is answered in one place, and a test that runs what it names |

## The promises the product makes

1. **Compose stays Compose.** The upstream file is untouched; appbay compiles beside it and
   the rendered file is readable by anyone who knows Compose. Nothing appbay adds locks an
   app in: delete `appbay.yaml` and the app is a plain Compose project again.
2. **Acceptable in an enterprise environment.** No plaintext secret at rest outside the
   vault, no secret on a command line, and an audit trail of what was deployed from what.
   The bar is what a security review of a Docker host would accept, not what a home lab
   tolerates.
3. **What the CLI reports is what it observed.** `deployed` means running and routed on an
   edge that exists; a check that could not run says unknown, never ok.
4. **Two instances of one app can share a host.** The namespace enters every generated
   name and carries that deployment's values.

Docker and Podman are both supported. How the two are kept apart is a rule about the code's
shape, not a promise to the user; it is in `structure.md`.

## Secrets: what is chosen, and what is established

The secrets trait lets a manifest choose how a resolved secret reaches the container:
`none`, `runtime-env` (the default), `wrapper-file`, or `entrypoint-wrapper`. The modes
differ in exposure: an environment variable is readable by anything that can inspect the
container; a wrapper file on a shared volume is readable by whatever mounts it; the
entrypoint wrapper decrypts into the process and nothing else. The manifest author chooses
with the exposure stated beside each mode in the secrets guide.

What is established, on Docker and on rootful Podman: no mode puts a value on a command
line or in a render; `runtime-env` puts it in the compose child's environment for the
duration of `up`; `wrapper-file` writes files on a volume through a helper container fed on
stdin; `entrypoint-wrapper` works when the injector binary is present, and shipping that
binary is open work. Two things the product does not yet promise: the vault's master
password is a file on disk beside the vault, and an install whose vault is locked falls back
to a plaintext `.env.local` and says so. Both are recorded as decisions for the maintainer.

## Decided definitions

These are the maintainer's, and a spec or a doc that contradicts one is wrong.

- **System** is physical: this box, this installation. Its runtime, socket, container store,
  home directory and base domain live in `etc/system.yaml`, written by `appbay init`. No
  manifest interpolates it.
- **Project** is intent: an operator saying "these apps run together to do something." An
  app declares `project: <name>`; absent means `default`. A project is the unit of
  composition: `when:` sees peers in the same project, and `etc/projects.yaml` orders
  projects. Compose calls each app directory a "project"; this is not that.
- **Namespace** is one deployment of a project: it enters every generated name, so two
  deployments of one project do not collide, and it names the values file that deployment
  resolves. `${{ns:KEY}}` is the one value scope a manifest references, read from
  `etc/namespaces/<ns>.yaml` layered over `default.yaml`, which init seeds with the system's
  `DOMAIN`. `--namespace` on `up`, `compile` and `apply` sets it for apps that pin none.
- **Collections and tags are labels.** They select (`up --collection`); they never compose,
  order, or hold values.
- **`when:` is about where, not when.** `when: [ollama]` asks whether `ollama` is in this
  app's project. It never asks whether `ollama` is running; readiness is the deploy's job.

## Boundaries

- The web control plane (`apps/web`) is a separate repository. This tree holds
  `packages/core` and `apps/cli`. A comment or test here that names a web caller describes
  something this tree cannot see.
- The catalog of installable apps is a sibling repository, `appbay-catalog`. This repo
  ships twelve system apps in `packages/core/src/system-apps.ts`, generated from `system-apps/`.
- Two runtimes are supported, and a change is not done until it has run on both.

## Related work

A Go reimplementation, stackbay, is being built from this repo's behaviour and from the
defects its history records. That is a fact about the maintainer's roadmap, not about this
product: appbay-cli is released, supported, and fixed on its own terms. The review track
that studies this codebase is described in `CLAUDE.md`, and its records live in
`docs/history/`.
