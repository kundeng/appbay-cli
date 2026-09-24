#!/usr/bin/env bash
# Declared-but-unreachable surface in AppBay: vocabulary with no producer, channels with
# no writer, exports with no non-test caller.
#
# The trait types file already documents two cases of this pattern by name (the `warnings`
# channel that "had NO producers", the `wrapper-live` injection mode "with no branch behind
# it"). This asks whether any remain, mechanically rather than by reading.
#
# Method: for each candidate symbol, CodeGraph's caller list decides, not grep. A symbol
# whose only callers are test files or barrel re-exports is unreachable from the product.
set -uo pipefail
SRC=${AB_SRC:?set AB_SRC}
cd "$SRC"

echo "===== 1. ShepherdPhase members with no producer ====="
for p in pre-deploy post-deploy on-stop cron; do
  n=$(grep -rn "phase: \"$p\"" --include=*.ts packages/core/src apps/cli/src 2>/dev/null | grep -v __tests__ | wc -l | tr -d ' ')
  c=$(grep -rn "\"$p\"" --include=*.ts packages/core/src/services/deploy/converges.ts 2>/dev/null | wc -l | tr -d ' ')
  echo "  phase '$p': $n producer(s), $c mention(s) in the runner"
done

echo
echo "===== 2. the trait warnings channel: any producer now? ====="
echo "  traits returning warnings:"
grep -rn 'warnings:' --include=*.ts packages/core/src/traits/definitions/ | grep -v __tests__ | sed 's/^/    /'
echo "  (empty = the channel documented as having no producers still has none)"

echo
echo "===== 3. ShepherdAction fields with no reader ====="
for f in schedule kind timeoutMs share mounts; do
  r=$(grep -rn "\.$f\b" --include=*.ts packages/core/src/shepherd packages/core/src/services/deploy 2>/dev/null | grep -v __tests__ | wc -l | tr -d ' ')
  echo "  ShepherdAction.$f: $r read site(s) in the shepherd/deploy path"
done

echo
echo "===== 4. exported compiler/trait symbols whose only callers are tests or barrels ====="
for sym in buildTraefikConfig traefikAuxPath caddyAuxPath buildCaddySnippet certResolverName routerName caddySecurityPolicy caddySecurityRoute whenClauseLabel mergeServiceFragment; do
  out=$(codegraph callers "$sym" 2>&1)
  total=$(printf '%s' "$out" | grep -oE 'Callers of "[^"]+" \(([0-9]+)\)' | grep -oE '[0-9]+' | head -1)
  prod=$(printf '%s' "$out" | grep -E '^\s+(packages|apps)/' | grep -v '__tests__' | grep -v '/index.ts' | wc -l | tr -d ' ')
  printf '  %-24s callers=%-3s non-test non-barrel call sites=%s\n' "$sym" "${total:-?}" "$prod"
done

echo
echo "===== 5. CLI / web parity: tRPC routers vs CLI commands ====="
WEB=/tmp/audited-ops-eval-20260924b/sources/appbay-mac/apps/web
if [ -d "$WEB" ]; then
  echo "  tRPC routers in the web app:"
  grep -rhoE '^\s*[a-zA-Z]+: [a-zA-Z]+Router' "$WEB/src/server" 2>/dev/null | sed 's/^\s*//' | sort -u | sed 's/^/    /'
  echo "  router files:"
  find "$WEB/src/server" -name '*.ts' | sort | sed "s|$WEB/src/server/|    |"
else
  echo "  (web app not present)"
fi
