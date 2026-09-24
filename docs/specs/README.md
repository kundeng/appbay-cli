# Specifications

Proposed specifications, each beside the investigation record that motivates it. A spec moves here as its own file when it becomes ACTIVE.

Two repositories, one rule — see [SPEC-000](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-000-gaps-not-to-close.md): `appbay-cli` is the open-source base, `appbay` is the enterprise fork, and the fork extends the base through seams that ship in the base first.

## OSS — `appbay-cli`, in order

- [SPEC-012-extension-seams](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-012-extension-seams.md) — Extension seams, so the enterprise fork extends instead of amending
- [SPEC-001-one-compose-environment-model](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-001-one-compose-environment-model.md) — One environment model across the compiler
- [SPEC-003-default-edge-matches-the-trait-set](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-003-default-edge-matches-the-trait-set.md) — The default edge must support the default trait set
- [SPEC-004-release-path-and-a-check-that-runs](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-004-release-path-and-a-check-that-runs.md) — A release path that works and a check that runs
- [SPEC-005-json-output-on-reporting-commands](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-005-json-output-on-reporting-commands.md) — Machine-readable output on every reporting command
- [SPEC-007-backup-honest-or-implemented](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-007-backup-honest-or-implemented.md) — Make the backup trait either real or absent
- [SPEC-006-multi-host-as-a-compiler-target](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-006-multi-host-as-a-compiler-target.md) — Multi-host, as a compiler target rather than a remote-control layer
- [SPEC-008-sso-on-the-edge](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-008-sso-on-the-edge.md) — SSO on the edge — providers declared once, compiled into the block that already exists
- [SPEC-011-git-sync-semantics](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-011-git-sync-semantics.md) — Sync semantics on the git catalog source that already exists

## Enterprise — `appbay`, in order, each after its OSS prerequisite

- [SPEC-002-one-deploy-path](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-002-one-deploy-path.md) — One deploy path for the CLI and the web
- [SPEC-009-gui-convenience](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-009-gui-convenience.md) — The Docker operations people ask for most, for AppBay's own apps, in the GUI
- [SPEC-010-scanning-and-updates](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-010-scanning-and-updates.md) — Vulnerability scanning and pending-update detection as registered system apps
- [SPEC-013-rbac-audit-users](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/SPEC-013-rbac-audit-users.md) — Per-operator authorization, an audit trail, and a users UI
- SPEC-006b (agent, fleet) lives inside SPEC-006, after 006a.

Report: [2026-09-24-appbay-dockhand-systematic-compose](../history/2026-09-24-appbay-dockhand-systematic-compose/docs/specs/../../REPORT-2026-09-24-appbay-dockhand-systematic-compose.md).
