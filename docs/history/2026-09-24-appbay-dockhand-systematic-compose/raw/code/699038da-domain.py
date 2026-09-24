"""Domain model for the AppBay/Dockhand comparison.

The objects this investigation reasons about are not tickets or hosts but CODE: the
compiler stages, traits and deploy paths whose behaviour the findings are about, and the
two products they belong to. Modelling them makes "which findings touch the same code"
and "which product does a finding concern" queryable without reopening the workbook.

`bridge()` is the only coupling to the claim layer: each finding is ABOUT the code sites
it concerns, and each record DERIVES the sites it examined.
"""
from __future__ import annotations

NODES = {
    "Product":  ("name", "name commit snapshot_date role"),
    "CodeSite": ("site", "site product path line symbol kind"),
    "Gap":      ("gap_id", "gap_id title decision spec"),
}

EDGES = {
    "SITE_IN":     ("CodeSite", "Product"),
    "GAP_AT":      ("Gap", "CodeSite"),
    "DISAGREES_WITH": ("CodeSite", "CodeSite"),
}

COHORTS = {
    "env-touching-sites": "every compiler site that reads or writes a service `environment:` field",
    "deploy-paths": "every code path that applies a compiled app to a runtime, in either product",
}

PRODUCTS = [
    ("Product", {"name": "appbay-cli", "commit": "9f00b579", "snapshot_date": "2026-09-24",
                 "role": "primary subject; CLI and core packages"}),
    ("Product", {"name": "appbay-web", "commit": "d8f557bc", "snapshot_date": "2026-08-09",
                 "role": "web and GUI surface; six weeks behind the CLI tree"}),
    ("Product", {"name": "dockhand", "commit": "99dc1044", "snapshot_date": "2026-09-24",
                 "role": "comparison subject; read, not executed"}),
]

# (site, product, path, line, symbol, kind)
SITES = [
    # The three environment-touching sites — the cohort the flagship finding is about.
    ("magic-vars",      "appbay-cli", "packages/core/src/compiler/compile.ts", 1019, "resolveMagicVars", "env-site"),
    ("scoped-env",      "appbay-cli", "packages/core/src/traits/definitions/scoped-env.ts", 34, "scopedEnvTraitDefinition", "env-site"),
    ("secrets-env",     "appbay-cli", "packages/core/src/traits/definitions/secrets.ts", 56, "secretsTraitDefinition", "env-site"),
    ("scoped-env-test", "appbay-cli", "packages/core/src/traits/definitions/__tests__/scoped-env.test.ts", 178, "object-form assertion", "test"),
    # Deploy paths, both products.
    ("cli-deploy",      "appbay-cli", "packages/core/src/services/deploy-service.ts", 154, "deploy", "deploy-path"),
    ("cli-route",       "appbay-cli", "packages/core/src/services/deploy/route.ts", 35, "writeRouteFiles", "deploy-path"),
    ("web-up",          "appbay-web", "apps/web/src/server/routers/deployments.ts", 159, "deployments.up", "deploy-path"),
    ("web-worker",      "appbay-web", "apps/web/src/server/queue/workers/deploy.ts", 63, "dockerComposeUp", "deploy-path"),
    ("web-fulldeploy",  "appbay-web", "apps/web/src/server/routers/deployments.ts", 420, "deployments.fullDeploy", "deploy-path"),
    ("web-plan",        "appbay-web", "apps/web/src/server/routers/plans.ts", 112, "plans.get", "display"),
    ("dh-deploy",       "dockhand",   "src/lib/server/stacks.ts", 3084, "deployStack", "deploy-path"),
    ("dh-rewrite",      "dockhand",   "src/lib/server/host-path.ts", 566, "rewriteComposeVolumePaths", "compose-transform"),
    ("dh-traefik-read", "dockhand",   "src/lib/utils/traefik-urls.ts", 34, "extractTraefikUrls", "label-reader"),
    ("dh-docker-fetch", "dockhand",   "src/lib/server/docker.ts", 789, "dockerFetch", "transport"),
    # The rest of the findings' anchors.
    ("default-edge",    "appbay-cli", "packages/core/src/schemas/instance.ts", 72, "DEFAULT_INGRESS_PROVIDER", "config"),
    ("auth-guard",      "appbay-cli", "packages/core/src/traits/definitions/auth.ts", 77, "authTraitDefinition", "trait"),
    ("release-install", "appbay-cli", ".github/workflows/release.yml", 53, "pnpm install --frozen-lockfile", "ci"),
    ("shepherd-phase",  "appbay-cli", "packages/core/src/traits/types.ts", 88, "ShepherdPhase", "type"),
    ("container-bin",   "appbay-cli", "packages/core/src/runtime/container-runtime.ts", 145, "containerBin", "transport"),
    ("docs-check",      "appbay-cli", "scripts/check-docs-cli.mjs", 1, "check-docs-cli", "ci"),
]

GAPS = [
    ("G1", "Map-form environment is silently lost", "close", "SPEC-001"),
    ("G2", "Web deploy path drops auxiliaryFiles", "close", "SPEC-002"),
    ("G3", "Default edge cannot run the auth trait", "close", "SPEC-003"),
    ("G4", "Stale lockfile breaks the release workflow", "close", "SPEC-004"),
    ("G5", "Only 4 of 47 commands emit JSON", "close", "SPEC-005"),
    ("G6", "No multi-host support", "close", "SPEC-006"),
    ("G7", "Backup trait is declared but unwired", "close", "SPEC-007"),
    ("G8", "No per-operator RBAC or audit trail", "leave", "SPEC-000"),
    ("G9", "GUI breadth an order of magnitude behind", "leave", "SPEC-000"),
    ("G10", "No vulnerability scanning or registry management", "leave", "SPEC-000"),
]

GAP_AT = [
    ("G1", "scoped-env"), ("G1", "magic-vars"), ("G1", "scoped-env-test"),
    ("G2", "web-up"), ("G2", "web-worker"), ("G2", "web-fulldeploy"), ("G2", "web-plan"),
    ("G3", "default-edge"), ("G3", "auth-guard"),
    ("G4", "release-install"), ("G4", "docs-check"),
    ("G6", "container-bin"), ("G6", "cli-route"),
    ("G7", "shepherd-phase"),
]

# The finding that matters most is a disagreement between sites, so it is an edge.
DISAGREEMENTS = [
    ("magic-vars", "secrets-env"),
    ("scoped-env", "secrets-env"),
    ("web-up", "cli-deploy"),
    ("web-worker", "cli-deploy"),
]

# (bridge type, claim node id, domain label, domain key)
BRIDGE = [
    ("ABOUT", "F1", "Product", "appbay-cli"),
    ("ABOUT", "F2", "Product", "dockhand"),
    ("ABOUT", "F2", "CodeSite", "dh-rewrite"),
    ("ABOUT", "F2", "CodeSite", "dh-traefik-read"),
    ("ABOUT", "F3", "CodeSite", "scoped-env"),
    ("ABOUT", "F3", "CodeSite", "magic-vars"),
    ("ABOUT", "F3", "CodeSite", "secrets-env"),
    ("ABOUT", "F4", "CodeSite", "scoped-env-test"),
    ("ABOUT", "F5", "CodeSite", "web-up"),
    ("ABOUT", "F5", "CodeSite", "web-worker"),
    ("ABOUT", "F5", "CodeSite", "web-fulldeploy"),
    ("ABOUT", "F6", "CodeSite", "default-edge"),
    ("ABOUT", "F6", "CodeSite", "auth-guard"),
    ("ABOUT", "F7", "CodeSite", "release-install"),
    ("ABOUT", "F8", "CodeSite", "dh-docker-fetch"),
    ("ABOUT", "F8", "CodeSite", "container-bin"),
    ("ABOUT", "F8", "CodeSite", "cli-route"),
    ("ABOUT", "F12", "CodeSite", "docs-check"),
    ("ABOUT", "F14", "CodeSite", "shepherd-phase"),
    ("ABOUT", "F15", "CodeSite", "cli-deploy"),
    ("DERIVES", "probe-05-map-form-environment-is-handled-three-ways", "CodeSite", "scoped-env"),
    ("DERIVES", "probe-05-map-form-environment-is-handled-three-ways", "CodeSite", "magic-vars"),
    ("DERIVES", "probe-06-dockhand-has-no-compose-overlay", "CodeSite", "dh-deploy"),
    ("DERIVES", "probe-06-dockhand-has-no-compose-overlay", "CodeSite", "dh-rewrite"),
    ("DERIVES", "analysis-11-map-form-defect-is-locked-in-by-a-test", "CodeSite", "scoped-env-test"),
    ("DERIVES", "analysis-13-web-deploy-drops-the-edge-route", "CodeSite", "web-up"),
    ("DERIVES", "analysis-14-dockhand-leads-and-their-mechanisms", "CodeSite", "dh-docker-fetch"),
    ("DERIVES", "action-15-auth-trait-error-does-not-stop-the-deploy", "CodeSite", "cli-deploy"),
    ("INCLUDES", "env-touching-sites", "CodeSite", "magic-vars"),
    ("INCLUDES", "env-touching-sites", "CodeSite", "scoped-env"),
    ("INCLUDES", "env-touching-sites", "CodeSite", "secrets-env"),
    ("INCLUDES", "deploy-paths", "CodeSite", "cli-deploy"),
    ("INCLUDES", "deploy-paths", "CodeSite", "web-up"),
    ("INCLUDES", "deploy-paths", "CodeSite", "web-worker"),
    ("INCLUDES", "deploy-paths", "CodeSite", "web-fulldeploy"),
    ("INCLUDES", "deploy-paths", "CodeSite", "dh-deploy"),
]


def nodes():
    yield from PRODUCTS
    for site, product, path, line, symbol, kind in SITES:
        yield ("CodeSite", {"site": site, "product": product, "path": path,
                            "line": line, "symbol": symbol, "kind": kind})
    for gap_id, title, decision, spec in GAPS:
        yield ("Gap", {"gap_id": gap_id, "title": title, "decision": decision, "spec": spec})


def edges():
    for site, product, *_ in SITES:
        yield ("SITE_IN", site, product, {})
    for gap_id, site in GAP_AT:
        yield ("GAP_AT", gap_id, site, {})
    for a, b in DISAGREEMENTS:
        yield ("DISAGREES_WITH", a, b, {})


def bridge():
    yield from BRIDGE
