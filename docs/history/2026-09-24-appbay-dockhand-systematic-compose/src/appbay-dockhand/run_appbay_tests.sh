#!/usr/bin/env bash
# What does AppBay's own test suite say about the tree at the pinned commit?
#
# Implementation maturity is a claim about whether the code does what it says, and the
# cheapest independent witness is the suite the authors wrote. Runs the workspace `test`
# task and keeps the full output; the per-package summary lines carry the counts.
set -uo pipefail
BUILD=${AB_BUILD:?set AB_BUILD}
cd "$BUILD"
pnpm turbo test 2>&1 | tail -120
echo "turbo-exit=${PIPESTATUS[0]}"
