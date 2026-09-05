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

1. **Runtime choice is configuration, not a code path.** Docker and Podman are both first
   class; there is no `if runtime == "podman"` in shared logic.
2. **What the CLI reports is what it observed.** `deployed` means running and routed on an
   edge that exists; a check that could not run says unknown, never ok.
3. **Compose stays Compose.** The upstream file is untouched; appbay compiles beside it and
   the rendered file is readable by anyone who knows Compose.
4. **Secrets never reach a render, an argv, or a log.**
5. **Two instances of one app can share a host.** The namespace enters every generated
   name.

## Decided definitions

These are the maintainer's, and a spec or a doc that contradicts one is wrong.

- **`when:` is about where, not when.** An overlay clause `when: [ollama]` asks whether
  `ollama` is declared in the same collection as this app. It is a statement about the
  composition of a stack, made at declaration time. It does not ask whether `ollama` is
  installed elsewhere in the home, and it never asks whether `ollama` is running. A
  dependent that is declared and not yet running still gets its overlay; readiness is the
  deploy path's problem, not the compiler's.
- **A collection is a stack.** The apps that declare the same collection are one deployable
  unit with a boot order. A collection is therefore a thing with a name and members, not a
  label that apps happen to share.
- **A namespace is identity.** It disambiguates two deployments of one app on one host by
  entering every generated name. It is not a value store.

## Boundaries

- The web control plane (`apps/web`) is a separate repository. This tree holds
  `packages/core` and `apps/cli`. A comment or test here that names a web caller describes
  something this tree cannot see.
- The catalog of installable apps is a sibling repository, `appbay-catalog`. This repo
  ships ten system apps in `packages/core/src/system-apps.ts`.
- Two runtimes are supported, and a change is not done until it has run on both.

## Related work

A Go reimplementation, stackbay, is being built from this repo's behaviour and from the
defects its history records. That is a fact about the maintainer's roadmap, not about this
product: appbay-cli is released, supported, and fixed on its own terms. The review track
that studies this codebase is described in `CLAUDE.md`, and its records live in
`docs/history/`.
