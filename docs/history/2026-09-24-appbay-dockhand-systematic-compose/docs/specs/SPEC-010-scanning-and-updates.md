---
spec: SPEC-010
title: Vulnerability scanning and pending-update detection as registered system apps
status: proposed
tier: Enterprise entries on an OSS seam
repo: appbay (entries), appbay-cli (seam via SPEC-012)
depends: SPEC-012
---
# SPEC-010 — Scanning and image updates

## Requirement

For managed apps: image vulnerability findings and pending-update detection, visible in
`doctor`, `list --json` and the GUI. Needed for enterprise readiness; declined earlier as a
priority call, not an architectural one.

## Design, on existing seams

- Trivy (Apache-2.0) and Watchtower (Apache-2.0, monitor-only) as system apps registered
  through SPEC-012. Each writes JSON to a shared volume; `doctor` and `list --json` read it.
  No scanning inside the compile path.
- Renovate is AGPL-3.0: not embedded. It may be run externally against the catalog.

## What it must not break

No automatic image updates — Watchtower stays monitor-only. Compile time unchanged.

## How to verify

`appbay doctor --json` reports a known-vulnerable fixture image's findings; `list` shows a
pending update for a deliberately old pinned tag.
