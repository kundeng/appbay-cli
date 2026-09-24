---
spec: SPEC-009
title: The Docker operations people ask for most, for AppBay's own apps, in the GUI
status: proposed
tier: Enterprise
repo: appbay
depends: SPEC-012, SPEC-002
---
# SPEC-009 — GUI convenience by absorption

## Requirement

Logs, shell, stats and restart for an AppBay-managed app, from the GUI — the operations the
CLI already has and never names. Not Docker-management breadth; that is a different product
and SPEC-000 declines it.

## Design, on existing seams

- Each button calls the same `@appbay/core` operation the CLI command calls — `logs`,
  `exec`, `shell`, `stats`, `restart`. Never a second spawn. Refactoring #4 found sixteen
  hardcoded `"docker"` spawn sites in the web server; this spec is their replacement.
- Log streaming: Dozzle (MIT) as a registered system app on the shared network, linked per
  app. Run it; do not embed it.
- Patterns may be read and adapted, with attribution, from Dockge (MIT, TypeScript,
  Compose-centric) and Portainer (Zlib). **Nothing from Dockhand** — BSL 1.1.

## What it must not break

No `docker` spawn in `apps/web` that core does not own. No Dockhand code in any form.

## How to verify

`grep -rn "spawn.*docker" apps/web` returns nothing. For each button, the core call is the
one the corresponding CLI command makes, by test.
