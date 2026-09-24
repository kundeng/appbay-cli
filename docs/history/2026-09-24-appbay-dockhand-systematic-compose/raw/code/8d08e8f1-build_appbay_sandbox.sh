#!/usr/bin/env bash
# Build a runnable AppBay sandbox from the immutable snapshot.
#
# NOTE: --no-frozen-lockfile is required; the pinned lockfile is stale (see action-01).
# The snapshot at $SRC is read-only and carries no node_modules, so nothing can be
# executed in place. This copies the tree to $DEST (outside the investigation record),
# installs dependencies and builds. The snapshot is never written.
set -euo pipefail

SRC=/tmp/audited-ops-eval-20260924b/sources/appbay-cli-mac
DEST=${APPBAY_SANDBOX:?set APPBAY_SANDBOX to the build location}

rm -rf "$DEST"
mkdir -p "$DEST"
# -a preserves the read-only modes; chmod back so pnpm can write.
rsync -a --exclude .kilo --exclude .git --exclude .codegraph "$SRC"/ "$DEST"/
chmod -R u+w "$DEST"

cd "$DEST"
pnpm install --no-frozen-lockfile 2>&1 | tail -20
pnpm build 2>&1 | tail -30

echo "--- built ---"
# apps/cli builds with `bun build --compile`, so the artifact is a native binary,
# not a JS entry point. Bun-compiled CLIs can drop piped stdout past 64 KB, so every
# later capture redirects to a regular file.
"$DEST/apps/cli/dist/appbay" --version
