#!/usr/bin/env bash
# Is scripts/check-docs-cli.mjs a real check, or does it pass vacuously?
#
# It reports 0 discrepancies on the tree as shipped. A green check proves nothing on its
# own — a checker that scans no files, or matches nothing, is also green. So: inject known
# drift into the SANDBOX copy (never the snapshot) and see whether it goes red.
#
# Three mutations, one per failure class the script claims to catch:
#   A. a documented command the binary does not have   (`appbay teleport`)
#   B. a documented flag the command does not have     (`appbay status --telepathy`)
#   C. control: restore, and confirm it returns to green.
set -uo pipefail

BUILD=${AB_BUILD:?set AB_BUILD}
RUN_DIR=${AB_RUN:?set AB_RUN}
DATA="$RUN_DIR/data"
mkdir -p "$DATA"
DOC="$BUILD/docs/reference/cli-commands.qmd"

cp "$DOC" "$DATA/cli-commands.qmd.orig"
restore() { cp "$DATA/cli-commands.qmd.orig" "$DOC"; }
trap restore EXIT

run_check() {
  ( cd "$BUILD" && node scripts/check-docs-cli.mjs 2>&1; echo "exit=$?" )
}

echo "===== baseline (tree as shipped) ====="
run_check | tee "$DATA/mutation-baseline.txt" | tail -6

echo
echo "===== mutation A: document a command that does not exist ====="
restore
printf '\n### `appbay teleport`\n\nSends the app somewhere else.\n\n```bash\nappbay teleport myapp\n```\n' >> "$DOC"
run_check | tee "$DATA/mutation-A.txt" | tail -8

echo
echo "===== mutation B: document a flag that does not exist ====="
restore
printf '\n### `appbay status`\n\n```bash\nappbay status --telepathy\n```\n' >> "$DOC"
run_check | tee "$DATA/mutation-B.txt" | tail -8

echo
echo "===== control: restored ====="
restore
run_check | tee "$DATA/mutation-control.txt" | tail -4
