#!/usr/bin/env bash
# Does Dockhand transform a Compose file on the way to the daemon?
#
# Three questions, each answered from the pinned source rather than the manual:
#   1. Which functions mutate compose CONTENT between "user saved it" and "docker compose ran it"?
#   2. Does any code WRITE a proxy label, proxy config file, or certificate directive?
#   3. What is Dockhand's relationship to Traefik/Caddy — producer or reader?
#
# CodeGraph answers the call-shape question; grep answers the "does this string ever get
# written" question. Both are recorded because neither alone settles it.
set -uo pipefail

DH=${DH_SRC:?set DH_SRC}
cd "$DH"

echo "===== 1. the compose content variable, from deploy to spawn ====="
echo "--- deployStack -> executeComposeCommand -> executeLocalCompose ---"
codegraph callees deployStack 2>&1 | head -40

echo
echo "===== 2. every call site that reassigns compose content before the spawn ====="
grep -n 'finalComposeContent' src/lib/server/stacks.ts

echo
echo "===== 3. the one compose rewriter, and its callers ====="
codegraph callers rewriteComposeVolumePaths 2>&1 | head -30

echo
echo "===== 4. is any proxy label/config ever WRITTEN? ====="
# A producer would have to emit one of these strings. A reader only matches them.
for pat in 'traefik\.http\.routers' 'traefik\.enable' 'certresolver' 'acme' 'letsencrypt' 'reverse_proxy' 'forward_auth' 'authorization policy'; do
  n=$(grep -rn "$pat" src/ --include=*.ts --include=*.svelte 2>/dev/null | grep -v openapi.generated | wc -l | tr -d ' ')
  echo "pattern '$pat': $n occurrence(s) in src/"
  grep -rn "$pat" src/ --include=*.ts --include=*.svelte 2>/dev/null | grep -v openapi.generated | sed 's/^/    /' | head -6
done

echo
echo "===== 5. what the Traefik/Caddy modules actually do ====="
codegraph node src/lib/utils/traefik-urls.ts 2>&1 | head -25
echo "---"
codegraph node src/lib/utils/caddy-urls.ts 2>&1 | head -25
