#!/usr/bin/env bash
# Run the VM-based journeys against one runtime and print a table.
#
# S28 Requirement 1.5: "A journey passing on one runtime and failing on the other is
# recorded as failing." Doing that by hand means running ~13 scripts twice and holding the
# results in your head, which is how a sweep ends up Docker-only and reported as if it were
# the whole answer.
#
# 🚨 IT CAPTURES WHOLE OUTPUT, AND THAT IS THE POINT. A hand sweep on 2026-08-16 piped each
# journey through `tail -4`; `s25-interface-optionality` returned 7/8 once and the failing
# assertion scrolled past the window, so the run produced a count with no cause. For a gate
# whose premise is "a run proves it, not a document", a failure you cannot name is
# indistinguishable from a real defect that only fires sometimes. Every run here lands whole
# in $OUTDIR.
#
#   ./run-all.sh                                              # Docker, default VM
#   VM=appbay-podman PRIV=sudo CBIN=podman HOME_DIR=/root/.appbay ./run-all.sh   # rootful
#   ONLY='compile lifecycle' ./run-all.sh                     # substring filter
#
# Exit is non-zero if any journey fails, so this is usable as a gate.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

VM="${VM:-appbay-docker}"
PRIV="${PRIV:-env}"
CBIN="${CBIN:-docker}"
# 🚨 MUST match what the CLI resolves on the target, or the sweep measures nothing.
# Measured 2026-08-16: a rootful Podman sweep (PRIV=sudo) wrote fixtures to the default
# /home/ubuntu/.appbay while `sudo appbay` compiled from /root/.appbay — "No apps found to
# compile" — and 15 journeys went red for a reason that had nothing to do with the runtime.
# S28's workflow calls this out: most Docker/Podman divergence is install-shape, not
# runtime, and S26 moved 15/31 -> 29/31 by aligning the installs rather than filing bugs.
HOME_DIR="${HOME_DIR:-/home/ubuntu/.appbay}"
ONLY="${ONLY:-}"
TIMEOUT="${TIMEOUT:-900}"
OUTDIR="${OUTDIR:-/tmp/journey-sweep-$VM}"

# ⚠️ These six ignore VM entirely and inspect whatever machine you are sitting on — see
# README "Six of these run LOCALLY". Including them in a runtime sweep would report the
# workstation's state as the VM's, which is exactly the confusion that produced
# `caddy version — expected v2.11.4, got '<none>'` against a host that simply lacked the
# image. They are listed, not silently dropped.
LOCAL_ONLY="s25-caddy-modules s25-caddy-tree-validate s25-control-plane-rebuild
            s26-journey-doctor-parity s26-journey-first-run-auth s26-journey-web-api-secrets"

# Needs a pristine host with no install and no credentials; a sweep host has both.
NEEDS_FRESH_VM="s27-journey-public-install"

# Only meaningful on a PODMAN sweep; running them on the Docker VM does not test
# the journey, it tests that a podman-only journey can fail for the wrong reason.
# s28-journey-rootful-podman walks the rootful Podman contract end to end — R0
# itself requires `container_runtime: podman` on disk, which a Docker install never
# has, so every later step fails on the wrong basis and the sweep reports a defect
# that does not exist.
PODMAN_ONLY="s28-journey-rootful-podman"

is_excluded() {
  # ⚠️ Normalise whitespace FIRST. The lists are multi-line for readability, so a name
  # sitting at the end of a line is followed by a NEWLINE, and the pattern *" $1 "* —
  # which needs a literal space on both sides — silently misses it. Measured: the podman
  # sweep ran `s25-control-plane-rebuild` (a local-only script that refuses without
  # APPBAY_HOME) and reported it as a runtime FAILURE. An exclusion list that quietly
  # excludes less than it says is worse than no list.
  local always
  always="$(printf '%s %s' "$LOCAL_ONLY" "$NEEDS_FRESH_VM" | tr -s '[:space:]' ' ')"
  case " $always " in *" $1 "*) return 0 ;; esac
  # PODMAN_ONLY is runtime-dependent, not universally excluded.
  if [ "$CBIN" != "podman" ] && [[ " $PODMAN_ONLY " == *" $1 "* ]]; then return 0; fi
  return 1
}

mkdir -p "$OUTDIR"
echo "== journey sweep =="
echo "   VM=$VM  PRIV=$PRIV  CBIN=$CBIN  HOME_DIR=$HOME_DIR"
echo "   full output -> $OUTDIR"
echo

ran=0; failed=0; skipped=0
declare -a ROWS

for f in s*.sh; do
  name="${f%.sh}"
  [ "$name" = "run-all" ] && continue
  if [ -n "$ONLY" ]; then
    match=0
    for pat in $ONLY; do case "$name" in *"$pat"*) match=1 ;; esac; done
    [ "$match" -eq 1 ] || continue
  fi
  if is_excluded "$name"; then
    ROWS+=("SKIP|$name|not a runtime sweep (local-only or needs a fresh VM)")
    skipped=$((skipped + 1))
    continue
  fi

  printf '  %-38s ' "$name"
  log="$OUTDIR/$name.log"
  VM="$VM" PRIV="$PRIV" CBIN="$CBIN" HOME_DIR="$HOME_DIR" \
    timeout "$TIMEOUT" bash "$f" > "$log" 2>&1
  rc=$?
  ran=$((ran + 1))

  # The scripts print "N passed, M failed" in a few decorated forms; take the last one.
  tally="$(grep -oE '[0-9]+ passed, [0-9]+ failed' "$log" | tail -1)"
  if [ "$rc" -eq 124 ]; then
    ROWS+=("FAIL|$name|TIMED OUT after ${TIMEOUT}s"); failed=$((failed + 1)); echo "TIMEOUT"
  elif [ "$rc" -eq 0 ]; then
    ROWS+=("PASS|$name|${tally:-exited 0}"); echo "ok    ${tally:-}"
  else
    # Pull the actual failing assertions, which is the whole reason this exists.
    why="$(grep -E '❌' "$log" | head -2 | tr '\n' ' ' | sed 's/  */ /g')"
    ROWS+=("FAIL|$name|${tally:-rc=$rc} :: ${why:-see $log}")
    failed=$((failed + 1)); echo "FAIL  ${tally:-rc=$rc}"
  fi
done

echo
printf '%-6s %-38s %s\n' "RESULT" "JOURNEY" "DETAIL"
printf '%-6s %-38s %s\n' "------" "--------------------------------------" "------"
for r in "${ROWS[@]}"; do
  IFS='|' read -r res nm detail <<< "$r"
  printf '%-6s %-38s %s\n' "$res" "$nm" "$detail"
done

echo
echo "$ran ran, $failed failed, $skipped not applicable to a runtime sweep"
echo "logs: $OUTDIR"
[ "$failed" -eq 0 ] || exit 1
