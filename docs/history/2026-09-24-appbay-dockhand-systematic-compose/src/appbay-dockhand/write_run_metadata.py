#!/usr/bin/env python3
"""Give every run the config.yaml and metrics.json its contract owes.

Each run here is one recorded inquiry against one or more pinned snapshots. The config
states what code produced it and what window ("data epoch") it saw — which for a source
investigation is the snapshot commit, since that is the whole of the observable world.
Metrics are derived from what the run left behind, not authored.
"""
from __future__ import annotations
import json, sys
# json.dumps doubles as a YAML double-quoted scalar emitter: a description containing
# ': ' is invalid unquoted YAML, and the projector swallows the parse error silently,
# leaving code_version empty with no complaint. Quote every scalar.
from pathlib import Path

INV = Path(sys.argv[1])
CODE_VERSION = "appbay-cli-mac@9f00b579 / appbay-mac@d8f557bc / dockhand@99dc1044"

# run id -> (producing script, what the run observed)
RUNS = {
    "compile-untouched-20260924": ("src/appbay-dockhand/compile_untouched_compose.sh",
        "one untailored compose compiled under both ingress providers"),
    "map-form-env-20260924": ("src/appbay-dockhand/map_form_environment.sh",
        "two services differing only in how environment: is spelled"),
    "dockhand-overlay-20260924": ("src/appbay-dockhand/dockhand_overlay_surface.sh",
        "every compose-mutation site and proxy-config string in dockhand src/"),
    "cli-exposure-20260924": ("src/appbay-dockhand/cli_exposure.sh",
        "superseded: counted subcommands and mismatched the --json grep"),
    "cli-exposure-20260924b": ("src/appbay-dockhand/cli_exposure.sh",
        "top-level commands of the built binary against docs/reference/cli-commands.qmd"),
    "docs-check-mutation-20260924": ("src/appbay-dockhand/docs_check_detects_drift.sh",
        "check-docs-cli.mjs against two injected discrepancies and a control"),
    "appbay-tests-20260924": ("src/appbay-dockhand/run_appbay_tests.sh",
        "the project's own vitest suites via turbo"),
    "env-defect-radius-20260924": ("src/appbay-dockhand/env_defect_blast_radius.sh",
        "CodeGraph callers/impact for the three environment sites and their tests"),
    "dead-surface-20260924": ("src/appbay-dockhand/appbay_dead_surface.sh",
        "producers and readers of each declared shepherd phase and field"),
    "web-cli-parity-20260924": ("src/appbay-dockhand/web_cli_parity.sh",
        "every web deploy path against the CLI's auxiliary-file installer"),
    "dockhand-leads-20260924": ("src/appbay-dockhand/dockhand_leads.sh",
        "each named Dockhand lead beside AppBay's counterpart or absence"),
    "auth-gap-20260924": ("src/appbay-dockhand/auth_error_still_deploys.sh",
        "appbay up against a default install whose auth trait errors; Docker 29.4.0"),
    "work-graph": ("src/appbay-dockhand/domain.py",
        "the projection itself: import CSVs and the LadybugDB rebuilt from raw/ and the store"),
}

for run_dir in sorted((INV / "runs").iterdir()):
    if not run_dir.is_dir():
        continue
    code, window = RUNS.get(run_dir.name, ("", ""))
    (run_dir / "config.yaml").write_text(
        f"run_id: {json.dumps(run_dir.name)}\n"
        f"code: {json.dumps(code)}\n"
        f"code_version: {json.dumps(CODE_VERSION)}\n"
        f"data_epoch: {json.dumps(window)}\n"
        "note: |\n"
        "  Sources are immutable snapshots, so the data epoch is the pinned commit set\n"
        "  rather than a time window. Nothing in these runs reads a live system except\n"
        "  auth-gap-20260924, which used the local Docker daemon and tore down after.\n")
    files = [p for p in run_dir.rglob("*") if p.is_file() and p.name not in
             ("config.yaml", "metrics.json")]
    (run_dir / "metrics.json").write_text(json.dumps({
        "run_id": run_dir.name,
        "artifact_count": len(files),
        "artifact_bytes": sum(p.stat().st_size for p in files),
        "has_logs": (run_dir / "logs").is_dir(),
        "producing_code": code,
    }, indent=2, sort_keys=True) + "\n")
    print(f"{run_dir.name}: {len(files)} artifact(s)")
