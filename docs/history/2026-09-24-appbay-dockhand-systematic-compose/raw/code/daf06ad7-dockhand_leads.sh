#!/usr/bin/env bash
# Where does Dockhand go further, and by what mechanism?
#
# ⚠️ LIMITATION, STATED HERE AND CARRIED WHEREVER THIS IS USED. This compares NAMED
# surfaces. A named-surface comparison cannot see a capability the other side has no
# name for — AppBay's trait compiler is exactly such a capability on Dockhand's side,
# which is why deliverable 2 was answered from call shape instead. Read this section as
# "what Dockhand has built that AppBay has not", not as a scorecard.
#
# For each lead: the mechanism in Dockhand's code, and AppBay's counterpart or absence.
set -uo pipefail
DH=${DH_SRC:?set DH_SRC}
AB=${AB_SRC:?set AB_SRC}

echo "===== MULTI-HOST ====="
echo "Dockhand: every host is an environments row; envId parameterises every call."
echo "  environments table columns:"
sed -n '23,49p' "$DH/src/lib/server/db/schema/index.ts" | grep -oE "^\s+\w+: \w+\('[a-z_]+'" | sed 's/^/    /'
echo "  connection types: $(grep -oE "'socket' \| 'direct' \| 'hawser-standard' \| 'hawser-edge'" "$DH/src/lib/server/db/schema/index.ts" | head -1)"
echo "  envId references in src/: $(grep -rn 'envId' "$DH/src" --include=*.ts --include=*.svelte | wc -l | tr -d ' ') across $(grep -rln 'envId' "$DH/src" --include=*.ts --include=*.svelte | wc -l | tr -d ' ') files"
echo "  transport: dockerFetch(path, opts, envId) — the Docker HTTP API, not a local binary"
grep -n 'async function dockerFetch' "$DH/src/lib/server/docker.ts" | sed 's/^/    /'
echo "AppBay: no host dimension exists."
echo "  spawn layer: $(grep -n 'export function containerSpawn\|export function containerExec\|export function containerCompose' "$AB/packages/core/src/runtime/container-runtime.ts" | tr '\n' ' ')"
echo "  none of them takes a host; they take appbayHome and spawn a LOCAL binary."
echo "  route delivery is a local filesystem write:"
grep -n 'join(appbayHome, aux.path)' "$AB/packages/core/src/services/deploy/route.ts" | sed 's/^/    /'
echo "  trait model states the assumption:"
sed -n '5,7p' "$AB/packages/core/src/traits/types.ts" | sed 's/^/    /'

echo
echo "===== MULTI-USER ====="
echo "Dockhand: users/sessions/roles/userRoles + a central authorize() gate."
grep -n 'export const \(users\|sessions\|roles\|userRoles\|apiTokens\|auditLogs\|ldapConfig\|oidcConfig\) = ' "$DH/src/lib/server/db/schema/index.ts" | sed 's/^/    /'
echo "  role scoping: roles.environmentIds (JSON array, null = all), userRoles unique on (user, role, environment)"
echo "  gate:"
grep -n 'can: (resource\|canAccessEnvironment: (' "$DH/src/lib/server/authorize.ts" | sed 's/^/    /'
echo "  RBAC is licence-gated: $(grep -c 'isEnterprise' "$DH/src/lib/server/authorize.ts") isEnterprise checks in authorize.ts"
echo "AppBay: identity is delegated to the edge, by design (RFC-001 §1)."
grep -n 'sole identity authority\|RFC-001 §1' "$AB/docs/rfc/"*.qmd 2>/dev/null | head -3 | sed 's/^/    /'
echo "  edge users command surface:"
"$AB/../../../../Users/kundeng/Projects/eval-audit-ops/runs/dockhand-v2/workdir/scratch/appbay-sandbox/apps/cli/dist/appbay" edge users --help 2>&1 | sed -n '1,14p' | sed 's/^/    /'

echo
echo "===== GUI ====="
echo "  Dockhand UI: $(find "$DH/src/routes" "$DH/src/lib/components" -type f \( -name '*.svelte' -o -name '*.ts' \) | wc -l | tr -d ' ') files, $(find "$DH/src/routes" "$DH/src/lib/components" -type f \( -name '*.svelte' -o -name '*.ts' \) -exec cat {} + 2>/dev/null | wc -l | tr -d ' ') lines"
echo "  Dockhand top-level pages: $(ls -d "$DH/src/routes"/*/ | wc -l | tr -d ' ')"
ls -d "$DH/src/routes"/*/ | xargs -n1 basename | tr '\n' ' '; echo
echo "  Dockhand API routes: $(find "$DH/src/routes/api" -name '+server.ts' | wc -l | tr -d ' ')"
WEB=/tmp/audited-ops-eval-20260924b/sources/appbay-mac/apps/web
echo "  AppBay web: $(find "$WEB/src" -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l | tr -d ' ') files, $(find "$WEB/src" -type f \( -name '*.ts' -o -name '*.tsx' \) -exec cat {} + 2>/dev/null | wc -l | tr -d ' ') lines"
echo "  AppBay web pages: $(ls -d "$WEB/src/app"/*/ | xargs -n1 basename | grep -v '^api$' | tr '\n' ' ')"

echo
echo "===== OTHER LEADS (named surfaces Dockhand has and AppBay does not) ====="
echo "  backups: $(ls "$DH/src/lib/server/backups" | wc -l | tr -d ' ') modules (restic: repo, snapshots, retention, restore, destinations)"
echo "    AppBay: backup trait emits metadata only; the CLI warns it is NOT SCHEDULED:"
grep -n 'backup declared but NOT SCHEDULED' "$AB/packages/core/src/services/deploy-service.ts" | sed 's/^/      /'
echo "  scheduled tasks: $(ls "$DH/src/lib/server/scheduler/tasks" | tr '\n' ' ')"
echo "  git-driven deploys: $(ls "$DH/src/lib/server" | grep -c '^git') git modules + gitRepositories/gitStacks tables + webhook auto-sync"
echo "    AppBay: catalog sources (a git clone of app definitions), no per-app repo sync:"
grep -n 'export async function' "$AB/packages/core/src/services/catalog-service.ts" | head -6 | sed 's/^/      /'
echo "  vulnerability scanning: vulnerabilityScans table + $(grep -rln 'vulnerabilit' "$DH/src" | wc -l | tr -d ' ') files"
echo "  audit log: auditLogs table + $(ls "$DH/src/lib/server" | grep -c 'audit') audit modules; AppBay: $(grep -rln 'audit' "$AB/packages/core/src" | wc -l | tr -d ' ') files"
echo "  notifications: $(ls "$DH/src/lib/server/notifications" | wc -l | tr -d ' ') modules"
echo "  registries / templates / image updates: registries, templateSources, pendingContainerUpdates tables"
echo "  remote agent: hawser (WebSocket edge + token-authed standard), $(ls "$DH/src/lib/server" | grep -c hawser) modules"
