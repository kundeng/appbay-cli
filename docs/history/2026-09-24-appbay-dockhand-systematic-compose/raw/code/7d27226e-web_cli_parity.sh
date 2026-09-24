#!/usr/bin/env bash
# Does the web UI deploy the same thing `appbay up` deploys?
#
# The compiler returns TWO outputs per app: `rendered` (the compose) and `auxiliaryFiles`
# (the edge route and the authorization policy). A deploy path that writes only the first
# starts the container and publishes no route. This asks, for every deploy path in the web
# app, whether auxiliaryFiles is written.
#
# Population: apps/web/src/server in the appbay-mac snapshot (d8f557bc, 2026-08-09) — the
# only web snapshot available. appbay-cli-mac is newer and has no web app.
set -uo pipefail
WEB=${AB_WEB:?set AB_WEB}
CLI=${AB_CLI_SRC:?set AB_CLI_SRC}

echo "===== deploy paths exposed by the web server ====="
grep -nE '^  [a-zA-Z]+: (protected|public)Procedure' "$WEB/src/server/routers/deployments.ts"
echo "job-queue workers:"
ls "$WEB/src/server/queue/workers/" | sed 's/^/  /'

echo
echo "===== which of them write auxiliaryFiles? ====="
echo "occurrences of auxiliaryFiles anywhere under apps/web/src:"
grep -rn 'auxiliaryFiles' "$WEB/src" | sed 's/^/  /'
echo "  (none => no web deploy path installs the edge route or the auth policy)"

echo
echo "===== for contrast: the CLI path ====="
grep -n 'auxiliaryFiles\|isRouteFilePath' "$CLI/packages/core/src/services/deploy-service.ts" "$CLI/packages/core/src/services/deploy/route.ts" | sed 's/^/  /' | head -12

echo
echo "===== which procedure does the UI actually call? ====="
for p in up enqueue fullDeploy applyPlan down restart; do
  n=$(grep -rn "deployments\.$p\b" "$WEB/src" --include=*.tsx --include=*.ts | grep -v '/server/' | wc -l | tr -d ' ')
  echo "  deployments.$p : $n call site(s) outside the server"
done
echo "  (fullDeploy is the one whose docstring claims 'feature parity with appbay up')"

echo
echo "===== runtime selection: one resolver, or hardcoded? ====="
echo "  web server spawn sites hardcoding \"docker\": $(grep -rn '"docker"' "$WEB/src/server/" | wc -l | tr -d ' ')"
echo "  CLI spawn sites hardcoding \"docker\" outside the resolver:"
grep -rn '"docker"' "$CLI/packages/core/src/runtime/container-runtime.ts" | grep -v 'PROFILES\|ContainerRuntimeSchema\|displayName\|DEFAULT_CONTAINER' | wc -l | tr -d ' '
echo "  CLI resolver: containerBin(appbayHome) -> $(grep -c 'containerBin(' "$CLI/packages/core/src/runtime/container-runtime.ts") use(s) in the runtime module"

echo
echo "===== has the web app drifted from the current core API? ====="
echo "  web calls compile({...activeApps}):"
grep -n 'activeApps' "$WEB/src/server/routers/deployments.ts" | sed 's/^/    /'
echo "  current core CompileOptions:"
grep -n 'deliberately no .activeApps' -A3 "$CLI/packages/core/src/compiler/compile.ts" | sed 's/^/    /'
