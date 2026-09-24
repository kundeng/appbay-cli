#!/usr/bin/env bash
# How much of the CLI is reachable from its own help and its own docs?
#
# Population: TOP-LEVEL commands only — the names `appbay --help` prints. Subcommand
# names (`appbay secrets get`, `appbay edge users`) are excluded: they are reached
# through their parent, so counting them as separate commands overstates both the
# surface and the documentation gap. Retirement notices (retired.ts) appear in help
# and are counted separately, because they are messages rather than capabilities.
#
# Procedure:
#   1. Parse the Commands: block of the built binary's --help.
#   2. Subtract the retirement notices declared in commands/retired.ts.
#   3. Compare against the command headings in docs/reference/cli-commands.qmd.
#   4. For each real command, ask ITS OWN --help whether it accepts --json, and
#      separately mark whether it reports state (it is a reporting command) — the
#      --json gap only matters for those.
#   5. Run the repo's own docs/CLI consistency check from the repo root, where its
#      relative binary path resolves.
set -uo pipefail

CLI=${AB_CLI:?set AB_CLI}        # the built binary
SRC=${AB_SRC:?set AB_SRC}        # the immutable snapshot (read-only)
BUILD=${AB_BUILD:?set AB_BUILD}  # the sandbox build root (for repo-relative scripts)
RUN_DIR=${AB_RUN:?set AB_RUN}
DATA="$RUN_DIR/data"
mkdir -p "$DATA"

"$CLI" --help > "$DATA/cli_help.txt" 2>&1

awk '/^Commands:/{f=1;next} f && /^  [a-z]/{print $1}' "$DATA/cli_help.txt" \
  | sed 's/|.*//' | sort -u > "$DATA/help_all.txt"

# Retirement notices: names in the RETIREMENTS table of commands/retired.ts.
grep -oE 'name: "[a-z-]+"' "$SRC/apps/cli/src/commands/retired.ts" \
  | sed 's/name: "//; s/"//' | sort -u > "$DATA/retired.txt"

# `help` is commander's built-in, not an appbay capability.
printf 'help\n' >> "$DATA/retired.txt"
sort -u -o "$DATA/retired.txt" "$DATA/retired.txt"

comm -23 "$DATA/help_all.txt" "$DATA/retired.txt" > "$DATA/commands.txt"

echo "===== top-level names in \`appbay --help\` ====="
echo "total:              $(wc -l < "$DATA/help_all.txt")"
echo "retirement notices: $(wc -l < "$DATA/retired.txt") ($(tr '\n' ' ' < "$DATA/retired.txt"))"
echo "real commands:      $(wc -l < "$DATA/commands.txt")"
tr '\n' ' ' < "$DATA/commands.txt"; echo

echo
echo "===== documented in docs/reference/cli-commands.qmd ====="
grep -oE '^#+ +`?appbay ([a-z][a-z-]*)' "$SRC/docs/reference/cli-commands.qmd" \
  | awk '{print $NF}' | tr -d '`' | sort -u > "$DATA/docs.txt"
echo "documented names: $(wc -l < "$DATA/docs.txt")"
echo "--- real commands with NO heading in the CLI reference ---"
comm -23 "$DATA/commands.txt" "$DATA/docs.txt" | tee "$DATA/undocumented.txt" | tr '\n' ' '; echo
echo "count: $(wc -l < "$DATA/undocumented.txt")"

echo
echo "===== --json support, per command, from its own --help ====="
: > "$DATA/json_support.tsv"
while read -r cmd; do
  [ -z "$cmd" ] && continue
  "$CLI" "$cmd" --help > "$DATA/help-$cmd.txt" 2>&1
  if grep -qE '(^|\s)--json(\s|,|$)' "$DATA/help-$cmd.txt"; then
    printf '%s\tjson\n' "$cmd" >> "$DATA/json_support.tsv"
  else
    printf '%s\tno-json\n' "$cmd" >> "$DATA/json_support.tsv"
  fi
done < "$DATA/commands.txt"
# Anchored so `no-json` cannot match the `json` count.
echo "with --json:    $(awk -F'\t' '$2=="json"' "$DATA/json_support.tsv" | wc -l | tr -d ' ')"
echo "without --json: $(awk -F'\t' '$2=="no-json"' "$DATA/json_support.tsv" | wc -l | tr -d ' ')"
echo "--- has --json ---"
awk -F'\t' '$2=="json"{print $1}' "$DATA/json_support.tsv" | tr '\n' ' '; echo

echo
echo "===== the repo's own docs/CLI check, run from the repo root ====="
( cd "$BUILD" && node scripts/check-docs-cli.mjs > "$DATA/check_docs_cli.txt" 2>&1; echo "exit=$?" )
cat "$DATA/check_docs_cli.txt"
