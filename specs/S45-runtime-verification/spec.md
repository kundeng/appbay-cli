---
spec_id: S45-runtime-verification
status: CLOSED
closed_as: SHIPPED
since: 2026-09-06
until: null
epic: correctness
features: [edge-ports-over-api, observed-outgoing-edge, traefik-local-tls, stdin-payload-padding, injector-selinux-label, docker-group-on-fresh-host]
supersedes: []
superseded_by: null
depends_on: [S44-identity-for-every-app]
anchors: [data-architecture]
---

# S45: what a Podman host and a RHEL Docker host found

# 1 · Requirements

## Introduction

Issues #9 (Podman verification of S36 and S38) and #8 (a Docker service install on a
RHEL-family host) were open because no such host was reachable. Kun's instruction: use Lima.
Two guests, a rootful Podman on Fedora 44 and Rocky 9.8 with Docker installed by
`init-system`, ran the journeys the issues named. Each thing they found is a ledger row
(29 to 35) and a task here; the one that is a sprint of its own is issue #11.

## Requirements

1.1 `inspectEdgePorts` SHALL read the Engine API, not `ps` text (Podman renders labels as
    `map[k:v]`); the arch allowlists for the file SHALL be removed.
1.2 `edge migrate` SHALL take the outgoing edge from what is observed running by label, and
    SHALL refuse by name when the target is already serving.
2.1 Traefik on a local TLD SHALL answer HTTPS with its default certificate: no strict SNI on
    the default options.
3.1 The shepherd's stdin payload SHALL survive base64 padding; the test SHALL run the writer.
3.2 The injector bind mount SHALL carry the SELinux relabel.
4.1 `init-system` SHALL grant the service account the docker group on a host where the plan
    itself installs Docker, and the unit SHALL order after `docker.service`.
5.1 The secrets guide SHALL state that the injector is a manual prerequisite (issue #11).

# 2 · Design

`inspectEdgePorts` is async over `apiListContainers`; a running container with a public
port 80 or 443 is its holder, and the holder is the outgoing edge iff its `com.appbay.app`
label equals the provider. `edge.ts` asks `findContainerByLabel` for both providers. The
payload is `name base64` per line. `planSystemBootstrap` takes a `commandExists` probe so a
test can plan against a host with no runtime.

# 3 · Tasks

- [x] 1.1, 1.2 edge port check over the API; migrate observes the outgoing edge
- [x] 2.1 `tls-options.yml`; system apps regenerated
- [x] 3.1 payload separator; the writer test runs `sh` on padded values
- [x] 3.2 `:ro,z`; `secrets-entrypoint-wrapper.test.ts`
- [x] 4.1 `init-system` grant on post-bootstrap state; `docker.service`; plan test
- [x] 5.1 secrets guide callout
- [x] 6.1 Podman (Fedora 44, rootful, SELinux enforcing): `s29-journey-deploy-reporting.sh` 10/10 through a multipass-to-Lima shim; `init --ingress-provider caddy`, `up caddy whoami`, whoami over HTTPS; `edge migrate --to traefik` and back, whoami served by each; `wrapper-file` lands `/run/secrets/wf/PW` with no env; `entrypoint-wrapper` with a hand-built injector: PID 1 sees the value, `inspect` does not
- [x] 6.2 Rocky 9.8 + Docker 29.8 installed by `init-system`: service account in `docker`, `appbay-server.service` active, `appbay.server` healthy, HTTP 200 on :3000, and the same after a reboot
- [x] 6.3 Docker (OrbStack): Traefik HTTPS 200 on `appbay.local`; `wrapper-file` with a padded value; `entrypoint-wrapper` with the injector under `DOCKER_DEFAULT_PLATFORM=linux/arm64`

## Log

**2026-09-06** — shipped. Issues #8 and #9 closed on the evidence above; issue #11 opened for
shipping the injector. The Lima guests `podman` and `rocky` are left running for Kun.
