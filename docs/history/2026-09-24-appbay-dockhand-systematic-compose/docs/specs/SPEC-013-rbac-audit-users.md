---
spec: SPEC-013
title: Per-operator authorization, an audit trail, and a users UI
status: proposed
tier: Enterprise
repo: appbay
depends: SPEC-008, SPEC-002
---
# SPEC-013 — RBAC, audit trail, users UI

## Requirement

Control-plane actions — deploy, delete, secrets — are authorized per operator, and every
one leaves an attributable record. Today the product has no audit log anywhere.

## Design, on existing seams

- Identity comes from the portal's JWT (SPEC-008). The GUI does not log anyone in; it reads
  who the edge says they are.
- Authorization: an action policy in the tRPC layer keyed on the JWT's roles. Roles are the
  ones SPEC-008 mapped; no new role store.
- Audit: an append-only table in `@appbay/db` — actor, action, app, host, compile hash,
  time — written by the deploy pipeline that SPEC-002 makes the only path. The CLI writes
  the same row with actor = OS user, so the trail is one table whichever door was used.
- Users UI: manage `users.json` through `appbay edge users` behind the GUI; nothing the CLI
  cannot do.

## What it must not break

No login separate from the portal. No audit row the CLI path does not also write.

## How to verify

Two users, two roles. The denied action fails at the tRPC gate naming the edge identity.
The audit table shows both attempts, one from the GUI and one from the CLI.
