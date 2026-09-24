#!/usr/bin/env bash
# Who is affected by the map-form environment defect, and what locks it in?
#
# probe-05 measured the loss. This establishes (a) the blast radius of each of the three
# disagreeing sites, from CodeGraph rather than from text search, and (b) that the
# scoped-env test suite ASSERTS the loss, which is why 1551 green tests did not catch it.
set -uo pipefail
SRC=${AB_SRC:?set AB_SRC}
cd "$SRC"

echo "===== the three sites ====="
sed -n '1017,1021p' packages/core/src/compiler/compile.ts | cat -n
echo "-- scoped-env.ts:32-41 --"
sed -n '32,41p' packages/core/src/traits/definitions/scoped-env.ts
echo "-- secrets.ts:94-100 (the site that gets it right) --"
sed -n '94,100p' packages/core/src/traits/definitions/secrets.ts

echo
echo "===== blast radius: scopedEnvTraitDefinition ====="
codegraph impact scopedEnvTraitDefinition 2>&1 | head -30
echo
echo "===== callers: scopedEnvTraitDefinition ====="
codegraph callers scopedEnvTraitDefinition 2>&1 | head -20
echo
echo "===== blast radius: the compile orchestrator that owns resolveMagicVars ====="
codegraph impact compile 2>&1 | head -35

echo
echo "===== the test that asserts the loss ====="
grep -n -A16 'treats object-form environment as empty array' packages/core/src/traits/definitions/__tests__/scoped-env.test.ts

echo
echo "===== the sibling trait's test asserting the OPPOSITE for the same construct ====="
sed -n '170,195p' packages/core/src/traits/definitions/__tests__/secrets.test.ts

echo
echo "===== which shipped manifests use map-form environment? ====="
echo "system-apps/ and catalogs in this tree:"
grep -rln 'environment:' --include=docker-compose.yml --include=docker-compose.yaml system-apps/ 2>/dev/null | while read -r f; do
  # map form: `environment:` followed by an indented `KEY:` rather than `- `
  if awk '/^[[:space:]]*environment:[[:space:]]*$/{f=1;next} f&&/^[[:space:]]*-/{print "list";exit} f&&/^[[:space:]]*[A-Za-z_]+:/{print "map";exit} f{exit}' "$f" | grep -q map; then
    echo "  MAP  $f"
  fi
done
echo "(no output above means every shipped manifest uses the list form)"
