---
spec_id: S42-crash-detection
status: CLOSED
closed_as: SHIPPED
since: 2026-09-05
until: null
epic: correctness
features: [restart-loop-is-crash, crash-grace-read, shepherd-target-by-label]
supersedes: []
superseded_by: null
depends_on: [S41-socket-observation]
anchors: [data-architecture]
---

# S42: the crash check sees a service that dies a moment later, and a restart loop

# 1 · Requirements

Ledger rows 4, 5 and 24 from the 2026-09-05 review, adopted as one small sprint.

4.1 A service in state `restarting` after `up -d` SHALL count as crashed ("restart-looping").
5.1 The crash check SHALL read once at once and once after a grace (`crashGraceMs`, default
    3 s) when the first read shows nothing wrong, so a service that dies a moment after start
    is seen; a crash on the first read does not wait.
24.1 WHEN a shepherd action shares a namespace with the app, THE target SHALL be the app's real
    container found by label, not the literal `appbay.<app>`.

# 2 · Design

`findCrashedServices` adds the `restarting` arm; `deploy()` wraps it in `crashCheck` with the
grace and the injected `sleep`; `runShepherdActions` carries the observer and resolves the
share target with `findByLabel(APP_LABEL, app)`.

# 3 · Tasks

- [x] 1.1 restart loop counted; grace re-read; shepherd target by label
- [x] 1.2 tests in `deploy-converge.test.ts`: grace catches a later death, restart loop fails, no wait when the first read already failed

## Log

**2026-09-05** — shipped with S41's observer; the grace adds up to 3 s per app on the new and changed paths.
