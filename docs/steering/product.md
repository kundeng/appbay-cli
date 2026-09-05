# Product

## What appbay-cli is

A control plane for Docker Compose applications on one host, running on Docker or
Podman. An app is an upstream `docker-compose.yml` plus an `appbay.yaml` beside it.
The manifest declares traits (ingress, GPU, auth, hooks, backup, secrets, scoped
env), a namespace, and conditional overlays. The compiler turns the pair into the
compose file that runs, and the deploy path converges it and installs its edge
route. The CLI is one binary built with Bun.

Kun runs it on his own hosts. There are no other operators.

## What it is now, in addition

The Go rewrite, stackbay, reimplements this command surface from the behaviour this
repo defines and from the defects its history records. That gives this repo a second
job: it is the specimen the rewrite learns from. Every defect found here is written
down with the seam it lives on, so the rewrite carries the lesson and not the bug.

The third job is teaching. Kun reads this codebase to become a strong code reviewer.
The code is read by seam, across files, and each finding names the file and line it
came from.

## The three goals, in priority order

1. **Correct.** A command that reports an outcome looked at the thing it reports on.
   The CLI on Kun's hosts deploys, routes, and reports truthfully on both runtimes.
2. **Legible.** One fact has one owner. A reader new to the codebase can find where a
   question is answered without finding it answered twice. Comments state the
   invariant; the history of how it was learned lives in `docs/history/`.
3. **Harvested.** Every seam defect found here has a lesson in the rewrite's design
   record before the rewrite reaches that seam.

## Who reads what

| reader | reads |
|---|---|
| Kun operating a host | `README.md`, `docs/guide/`, `appbay doctor` |
| Kun reviewing the code | the seam and ledger records in `docs/history/`, then the file under review |
| the rewrite | `docs/history/`, the fix history in git, the journeys under `scripts/journeys/` |

## Decided definitions

These are Kun's, and a spec or a doc that contradicts one is wrong.

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

- The web control plane (`apps/web`) is a separate private repository. This tree holds
  `packages/core` and `apps/cli` only. Comments and tests here that name a web caller
  describe something this tree cannot see.
- The catalog of installable apps is a sibling repository, `appbay-catalog`. This repo
  ships ten system apps in `packages/core/src/system-apps.ts`.
- Two runtimes are supported, Docker and Podman, and a change is not done until it
  has run on both.
