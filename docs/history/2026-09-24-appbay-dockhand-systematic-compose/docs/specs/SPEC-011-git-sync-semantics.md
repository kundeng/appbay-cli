---
spec: SPEC-011
title: Sync semantics on the git catalog source that already exists
status: proposed
tier: OSS
repo: appbay-cli
---
# SPEC-011 — Git sync semantics

## Requirement

A git catalog source refreshes on a schedule or a webhook and reports drift per app. This
is smaller than first written: `git` is already a source type (`schemas/catalog.ts:22`);
what is missing is the trigger and the report, not the kind.

## Design, on existing seams

- Source schema gains `sync: { schedule?: cron, webhook?: { path, secret: <secret URI> } }`.
- `catalogUpdateSource` gains a trigger; a `catalog status` command shows each source's
  commit and each app's drift from it.
- Per-app git instances are not a new subsystem: an app whose definition is a catalog entry
  re-resolves on source update and is picked up on the next `apply`.

## What it must not break

No second git model beside catalog sources.

## How to verify

Push to a test repository; the webhook fires; `catalog status` shows the new commit; the
app compiles with the change on the next `apply`.
