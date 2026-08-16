# Appbay BDD Test Suite

## Structure

```
tests/bdd/
├── README.md                         # This file
├── features/                         # WHAT: Gherkin feature files (human-readable)
│   ├── app_lifecycle.feature         # Deploy, compile, validate, eject
│   ├── secrets_management.feature    # Vault CRUD, injection, scan, import
│   ├── auth_management.feature       # Authentik SSO, per-app auth, users
│   ├── ingress_routing.feature       # Traefik routing, exposure modes
│   ├── system_health.feature         # Doctor, rebuild-cache, system info
│   └── traits_and_overlays.feature   # Trait system, overlays, scoped vars
│
├── cli_smoke.robot                   # HOW: CLI smoke (8 tests, fast)
├── secrets_lifecycle.robot           # HOW: Secrets integration (6 tests)
└── deploy_lifecycle.robot            # HOW: Deploy integration (8 tests)
```

## Two layers, one purpose

| Layer | Files | Purpose |
|-------|-------|---------|
| **Feature files** (.feature) | `features/*.feature` | Human-readable BDD scenarios in Gherkin. Maps to [feature-ledger.md]. The test plan. |
| **Robot suites** (.robot) | `*.robot` | Executable automation against live VM. The test implementation. |

Feature files describe WHAT to test. Robot suites implement HOW to test.
Not every feature scenario has a Robot implementation yet — the features
are the target; the suites grow toward them.

## Feature → Ledger mapping

| Feature file | Ledger items covered |
|-------------|---------------------|
| `app_lifecycle.feature` | 1.1-1.3, 1.14-1.15, 1.17-1.18, 3.2-3.7 |
| `secrets_management.feature` | 1.12-1.13, 3.9, 3.27-3.29, S09, S15 |
| `auth_management.feature` | 1.7, 3.26, S08 |
| `ingress_routing.feature` | 1.5, S06, S07 |
| `system_health.feature` | 3.10, 3.17, 4.3 |
| `traits_and_overlays.feature` | 1.4-1.9, 1.10-1.11, S15 |

## Running

```bash
# All suites against the VM
cd ~/Dropbox/Projects/aitester-bdd
uv run robot ~/Dropbox/Projects/appbay/tests/bdd/

# Just the smoke suite (fastest)
uv run robot ~/Dropbox/Projects/appbay/tests/bdd/cli_smoke.robot

# Just secrets
uv run robot ~/Dropbox/Projects/appbay/tests/bdd/secrets_lifecycle.robot
```

## Prerequisites

- multipass VM `appbay-test` running with appbay installed
- aitester-bdd project at `~/Dropbox/Projects/aitester-bdd`
- Robot Framework (installed via aitester-bdd's uv environment)

## Coverage status

| Suite | Tests | Scenarios covered from features |
|-------|-------|---------------------------------|
| cli_smoke.robot | 8 | app_lifecycle (2), secrets (2), auth (2), system (2) |
| secrets_lifecycle.robot | 6 | secrets_management (6) |
| deploy_lifecycle.robot | 8 | app_lifecycle (4), auth (3), system (1) |
| traits_and_overlays.robot | 9 | traits_and_overlays (6), ingress_routing (3) |
| **Total** | **31** | **~29 of 52 feature scenarios** |
