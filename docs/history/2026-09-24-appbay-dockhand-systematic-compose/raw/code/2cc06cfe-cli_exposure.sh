#!/usr/bin/env bash
# How much of the CLI is reachable from its own help and its own docs?
#
# The prior review counted 47 shipped / 34 documented and "16 of 23 state-reporting
# commands have no --json" by reading index.ts. This counts from the BUILT BINARY's
# own `--help` output instead, so the number is what a user can actually see, and
# cross-checks it against the docs in the same tree.
set -uo pipefail

CLI=${AB_CLI:?set AB_CLI}
SRC=${AB_SRC:?set AB_SRC}
RUN_DIR=${AB_RUN:?set AB_RUN}
DATA="$RUN_DIR/data"
mkdir -p "$DATA"

# Bun-compiled binary: redirect to a file, never a pipe.
"$CLI" --help > "$DATA/cli_help.txt" 2>&1

# Commander lists commands in the "Commands:" block, one per line, name first.
awk '/^Commands:/{f=1;next} f && /^  [a-z]/{print $1}' "$DATA/cli_help.txt" \
  | sed 's/|.*//' | sort -u > "$DATA/commands_in_help.txt"

# Every command registered in the CLI entry point, whether or not help shows it.
grep -oE '^\s*\.addCommand\((\w+)' "$SRC/apps/cli/src/index.ts" | grep -oE '\w+Command' | sort -u > "$DATA/commands_registered_raw.txt"
grep -oE 'new Command\("([^"]+)"\)' -r "$SRC/apps/cli/src/commands/" | sed 's/.*new Command("//; s/")//' | sort -u > "$DATA/commands_declared.txt"

echo "===== commands visible in \`appbay --help\` ====="
wc -l < "$DATA/commands_in_help.txt"
cat "$DATA/commands_in_help.txt" | tr '\n' ' '; echo

echo
echo "===== command names declared under apps/cli/src/commands/ ====="
wc -l < "$DATA/commands_declared.txt"
cat "$DATA/commands_declared.txt" | tr '\n' ' '; echo

echo
echo "===== declared but NOT in the top-level help ====="
comm -13 "$DATA/commands_in_help.txt" "$DATA/commands_declared.txt" | tee "$DATA/undocumented_in_help.txt" | tr '\n' ' '; echo

echo
echo "===== documented in docs/reference/cli-commands.qmd ====="
grep -oE '^#+ +`?appbay ([a-z][a-z-]*)' "$SRC/docs/reference/cli-commands.qmd" \
  | awk '{print $NF}' | tr -d '`' | sort -u > "$DATA/commands_in_docs.txt"
wc -l < "$DATA/commands_in_docs.txt"

echo
echo "===== in help but absent from the CLI reference doc ====="
comm -23 "$DATA/commands_in_help.txt" "$DATA/commands_in_docs.txt" | tee "$DATA/help_not_in_docs.txt" | tr '\n' ' '; echo

echo
echo "===== which commands accept --json? (from each command's own --help) ====="
: > "$DATA/json_support.tsv"
while read -r cmd; do
  [ -z "$cmd" ] && continue
  out=$("$CLI" "$cmd" --help 2>&1 | head -200)
  if printf '%s' "$out" | grep -q -- '--json'; then
    printf '%s\tjson\n' "$cmd" >> "$DATA/json_support.tsv"
  else
    printf '%s\tno-json\n' "$cmd" >> "$DATA/json_support.tsv"
  fi
done < "$DATA/commands_in_help.txt"
echo "with --json:   $(grep -c 'json$' "$DATA/json_support.tsv")"
echo "without --json: $(grep -c 'no-json$' "$DATA/json_support.tsv")"
echo "--- without --json ---"
grep 'no-json$' "$DATA/json_support.tsv" | cut -f1 | tr '\n' ' '; echo

echo
echo "===== does the docs-CLI consistency check actually check anything? ====="
node "$SRC/scripts/check-docs-cli.mjs" > "$DATA/check_docs_cli.txt" 2>&1
echo "exit=$?"
cat "$DATA/check_docs_cli.txt"
