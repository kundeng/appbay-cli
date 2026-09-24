---
spec: SPEC-008
title: SSO on the edge — providers declared once, compiled into the block that already exists
status: proposed
tier: OSS
repo: appbay-cli
depends: SPEC-003
---
# SPEC-008 — SSO on the edge

## Requirement

`project.yaml` declares identity providers — OIDC, LDAP — once. `compile` writes them into
the edge's caddy-security configuration. Roles from the provider reach the `auth` trait's
existing checks. There is no second credential store. This is what "minimal enterprise lab
ready" means for the CLI release.

## Design, on existing seams

The compiled edge block at `system-apps.ts:100–140` already has a filesystem local identity
store (`/etc/caddy/security/users.json`), an authentication portal, JWT signing from
`APPBAY_EDGE_TOKEN_SECRET`, and a `transform user { match origin local }` stage.
caddy-security speaks OIDC and LDAP natively. So:

- `project.yaml` gains `identity.providers[]` — `{ name, kind: oidc | ldap, issuer | url,
  client_id, client_secret: <secret URI>, groups_claim }`. Secrets by reference through the
  existing secret-URI path; never inline.
- The block gains one provider stanza per entry and one `transform user { match origin
  <name> }` mapping the provider's groups claim to the roles that `caddySecurityPolicy`
  (`auth.ts:28`) and the `auth` trait's `group` already test.
- `appbay edge users` keeps managing the local store; local and provider identities coexist
  in one portal, which is the point.
- Traefik: out of scope. SPEC-003 makes Caddy the default that carries the trait set.

## What it must not break

`users.json` semantics; an installation with no providers declared compiles the same block
it does today; RFC-001 §1 — the edge stays the sole identity authority.

## How to verify

With dex in a test container as the OIDC provider: a login reaches an app whose `auth`
trait requires `group: admins`; a user without the group gets `policy: deny`; `appbay
eject` of that app still runs without the portal, because auth is edge-side.
