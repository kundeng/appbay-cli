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
`none`, `runtime-env` (the default), `wrapper-file`, `entrypoint-wrapper`, or
`wrapper-live`. The modes differ in exposure: an environment variable is readable by
anything that can inspect the container; a wrapper file on a shared volume is readable by
whatever mounts it; a live wrapper narrows the window further. The product's position is
that the manifest author chooses with the exposure stated beside each mode, and that the
default is the safest mode the app can run under.

What has not been established is that every mode keeps the secret out of a render, an
argv, and a log. The fix history has three defects of that shape, and the review has not
yet audited the current modes. Until it has, this page states the intent and not the
guarantee; the security-review pass named in the verification sprint is where the
guarantee is earned, mode by mode.

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
- **A namespace is identity, and it carries values.** It enters every generated name, so
  two deployments of one app on one host do not collide. It is also where per-deployment
  values live: `${{namespace.KEY}}` resolves from a values file for that namespace, the way
  `project.yaml` and `environment.yaml` once meant to, with `${{project.KEY}}` as the
  per-host layer beneath it. One axis with both jobs is simpler than a name axis and a
  separate value tier. This reverses the S32 audit's rejection of RFC-001 item 4.6.

## Open questions

- **Single-node Swarm mode.** Swarm carries a runtime secret store (`docker secret`),
  mounted into containers as files rather than passed as environment. Running compose
  stacks under a one-node swarm would give the `wrapper-file` mode a store the runtime
  owns instead of one appbay writes. Whether Podman has an equivalent, and what the
  deploy path would look like as `stack deploy`, is unmeasured. Open until someone runs it.

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
