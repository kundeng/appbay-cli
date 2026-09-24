---
spec: SPEC-007
title: Make the backup trait either real or absent
closes: F14, and the backup half of F8's comparison
status: proposed
priority: 7 — low effort, removes a standing safety claim
---

# SPEC-007 — Make the backup trait either real or absent

## Requirement

A manifest that declares `backup:` must either result in backups being taken, or fail to
compile. The current third state — accepted, displayed, and never acted on — must not
survive.

## Why

The `backup` trait returns compose unchanged and emits metadata "for the scheduler/job
queue to pick up at runtime". On a CLI-only install that queue does not exist, and
`deploy-service.ts:112-131` says so in an unusually good comment and a loud warning:
*"backup declared but NOT SCHEDULED … Treat these apps as UNPROTECTED."* That is honest
engineering and it converted a silent gap into a stated one.

It should not stay stated indefinitely. Two of AppBay's own shipped manifests —
`nextcloud` and `homeassistant` — declare `backup` with a schedule and a retention, which
means the product's own catalog ships apps whose backup configuration does nothing on the
installation type the product primarily targets. A warning at deploy time is read once.

Note that the queue **does** exist, in `appbay-mac`'s
`apps/web/src/server/queue/backup-scheduler.ts` and `queue/workers/backup.ts`. So this is
not a missing capability so much as the same CLI/web split SPEC-002 addresses, seen from
another side.

## Design, on existing seams

Three options; the recommendation is the second.

**(a) Delete the trait.** Honest and cheap, but throws away a correct declaration and
forces every operator to invent their own scheduling.

**(b) Recommended — run it through the shepherd's `cron` phase.** `ShepherdPhase` already
declares `"cron"` and `ShepherdAction` already declares `schedule`; both are dead
vocabulary today ([F14](../../INVESTIGATION-2026-09-24-appbay-dockhand-systematic-compose.md#f14)).
The backup trait becomes a producer of a `phase: "cron"` shepherd action, and a runner is
added that registers those actions with the host's scheduler — a systemd timer on a service
install, which `apps/cli/src/utils/systemd-unit.ts` already knows how to write. This uses
two declared-but-unused seams for their stated purpose instead of deleting them, and it
keeps execution out of the compiler.

Deliberately **not** in scope: building a restic equivalent. Dockhand's backup subsystem is
37 modules covering repositories, snapshots, retention, restore targets and destinations.
That is a product in itself, and AppBay's trait describes *which volumes matter*, which is
the part AppBay uniquely knows. Emitting a correct `restic`/`borg` invocation from the
trait's volume list is the whole contribution; owning the backup engine is not.

**(c) Fail closed.** Make `backup` a compile error when no runner is configured. Correct in
principle, but it would fail two shipped system apps on every install, so it is only
reachable after (b).

## What it must not break

- **The deploy-time warning must stay until a runner is actually wired**, and must
  disappear only when one is. A warning that stops appearing because the trait was
  refactored, not because backups happen, is the worst outcome available here.
- **`traitMetadata` merge semantics.** `trait-engine.ts:267` merges with `Object.assign`
  keyed by trait type, so an app with two backup traits would overwrite its own entry —
  the same hazard `compile.ts:346-350` documents for ingress. App-scope makes this moot
  today; keep it app-scoped.
- **`appbay-mac`'s backup worker** is a real implementation. Reconcile with it rather than
  writing a third one — the mistake SPEC-002 exists to undo.

## How to verify

- A declared backup produces a registered timer, observable with `systemctl list-timers`.
- The `NOT SCHEDULED` warning appears when no runner is configured and not when one is.
- A restore is exercised at least once. An untested restore is not a backup, and this is
  the assertion Dockhand's `restore-core.ts` and `restore-service.ts` exist to make.
