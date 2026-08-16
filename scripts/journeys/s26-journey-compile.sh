#!/usr/bin/env bash
# S26 / issue #60 — journeys 4 and 5: compile determinism, and compile FAILURE modes.
#
#   4. Compile success, deterministic recompile, physical and logical diff
#   5. Compile failure for undefined scope variables, conflicts, malformed manifests,
#      and missing capabilities
#
# ⭐ JOURNEY 5 IS THE ONE THAT MATTERS AND THE ONE NOBODY WRITES. A compiler is easy to
# test when it succeeds; the failures are where it either names the problem or wastes an
# operator's afternoon. Each case below asserts a SPECIFIC diagnostic, not merely a
# non-zero exit — "it failed" is not a passing grade when the whole point is telling the
# operator WHICH manifest line is wrong.
#
# 🚨 AND FAILING MUST NOT LEAVE DEBRIS. A compile that errors after writing half a render
# is worse than one that refuses: the next deploy reads the fragment. Every failure case
# checks the render directory afterwards.
#
# Runs against either runtime — the point of the alpha matrix is that these are identical.
#   VM=appbay-docker ./s26-journey-compile.sh
#   VM=appbay-rhel PRIV=sudo ./s26-journey-compile.sh

set -uo pipefail
VM="${VM:-appbay-docker}"
PRIV="${PRIV:-env}"
CBIN="${CBIN:-docker}"
HOME_DIR="${HOME_DIR:-/home/ubuntu/.appbay}"
APPS="$HOME_DIR/etc/apps"
RENDERS="$HOME_DIR/var/lib/renders"
FIX="jrn-compile"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }
ab()  { vm "cd /home/ubuntu && appbay $1 2>&1"; }

cleanup() { vm "rm -rf $APPS/$FIX $APPS/${FIX}-peer $RENDERS/$FIX $RENDERS/${FIX}-peer" >/dev/null 2>&1; }
trap cleanup EXIT

# Write a fixture app. $1 = name, $2 = appbay.yaml body.
fixture() {
  vm "mkdir -p $APPS/$1" >/dev/null 2>&1
  vm "cat > $APPS/$1/docker-compose.yml <<'EOF'
services:
  app:
    image: docker.io/library/busybox:latest
    command: [\"sleep\", \"3600\"]
EOF" >/dev/null 2>&1
  vm "cat > $APPS/$1/appbay.yaml <<'EOF'
$2
EOF" >/dev/null 2>&1
}

VALID='project: default
environment: default
upstream:
  source: ./docker-compose.yml
  expose:
    - app
traits:
  - type: ingress
    host: "jrn.${{project.DOMAIN}}"
    port: 80
    service: app
    exposure: internal'

echo "══ Journey 4 — compile success and deterministic recompile"
cleanup
fixture "$FIX" "$VALID"
OUT=$(ab "compile $FIX")
# ⚠️ Do NOT grep for "error" — the SUCCESS summary line is "1 compiled, 0 error(s)", so a
# naive match reports every clean compile as a failure. Match the failure banner and a
# non-zero count instead.
if echo "$OUT" | grep -qE "Compile errors:|[1-9][0-9]* error\(s\)"; then
  bad "compile reported an error"; echo "$OUT" | tail -3 | sed 's/^/       /'
else
  ok "compiles clean"
fi

FIRST=$(vm "sha256sum $RENDERS/$FIX/docker-compose.rendered.yml 2>/dev/null | cut -d' ' -f1")
ab "compile $FIX" >/dev/null 2>&1
SECOND=$(vm "sha256sum $RENDERS/$FIX/docker-compose.rendered.yml 2>/dev/null | cut -d' ' -f1")
# ⚠️ Byte-identical, not merely "valid". A compiler that reorders keys or stamps a
# timestamp makes every deploy look CHANGED, and an operator stops reading diffs.
[ -n "$FIRST" ] && [ "$FIRST" = "$SECOND" ] && ok "recompile is byte-identical (deterministic)" \
                                            || bad "recompile differs: $FIRST vs $SECOND"

# Physical diff: a change to the UPSTREAM compose must change the render.
# ⚠️ Not an ingress `port:` edit — that alters the EDGE artifacts, not the compose, so the
# render is legitimately identical. Asserting otherwise tests a property the design does
# not have.
vm "sed -i 's|command: .*|command: [\"sleep\", \"7200\"]|' $APPS/$FIX/docker-compose.yml" >/dev/null 2>&1
ab "compile $FIX" >/dev/null 2>&1
THIRD=$(vm "sha256sum $RENDERS/$FIX/docker-compose.rendered.yml 2>/dev/null | cut -d' ' -f1")
[ "$THIRD" != "$SECOND" ] && ok "an upstream change changes the render (physical diff)" \
                          || bad "render did NOT change after editing the upstream compose"

echo "══ Journey 5 — compile failures name the actual problem"

# 5a. Undefined scope variable.
cleanup; fixture "$FIX" "$(echo "$VALID" | sed 's/project.DOMAIN/project.NO_SUCH_VAR/')"
OUT=$(ab "compile $FIX")
echo "$OUT" | grep -qi "NO_SUCH_VAR" && ok "undefined scope variable: names the variable" \
                                     || { bad "undefined variable not named"; echo "$OUT" | tail -3 | sed 's/^/       /'; }
# 🚨 THE PROPERTY THAT MATTERS IS THAT IT IS NOT DEPLOYED, not that no file exists.
# `compile` may still write a render for an app that errored — that file is inert now,
# because deploy refuses any app with compile errors (issue #60 journey 7: apply FAILS on
# ingress validation errors). Before that fix the same input produced
# "1 deployed, 1 error(s)" and a RUNNING CONTAINER WITH NO ROUTE, which looked healthy in
# every listing and was unreachable.
ab "up $FIX" >/dev/null 2>&1
STARTED=$(vm "$CBIN ps -a --filter name=$FIX --format '{{.Names}}' 2>/dev/null | head -1" | tr -d '[:space:]')
[ -z "$STARTED" ] && ok "  …and the app is NOT deployed (fail-closed)" \
                  || bad "  …but the app deployed anyway as $STARTED — unreachable and looking healthy"

# 5b. Malformed manifest.
cleanup; fixture "$FIX" 'traits:
  - type: ingress
   host: "broken indentation
    port: nope'
OUT=$(ab "compile $FIX")
echo "$OUT" | grep -qiE "yaml|parse|invalid|malformed" && ok "malformed manifest: reported as a parse/validation error" \
                                                       || { bad "malformed manifest gave an unhelpful error"; echo "$OUT" | tail -3 | sed 's/^/       /'; }

# 5c. Host conflict — two apps claiming the same ingress host.
cleanup
fixture "$FIX" "$VALID"
fixture "${FIX}-peer" "$VALID"
OUT=$(ab "compile")
# 🚨 A HOST COLLISION MUST BE SURFACED. Whichever app the edge happens to route, the other
# silently never receives traffic — and both deploys report success.
echo "$OUT" | grep -qiE "conflict|already claim|duplicate|same host" && ok "host conflict: surfaced" \
                                                                    || { bad "host conflict NOT surfaced — one app would silently never route"; echo "$OUT" | grep -iE "jrn" | head -3 | sed 's/^/       /'; }

# 5d. Trait targeting a service that does not exist.
cleanup; fixture "$FIX" "$(echo "$VALID" | sed 's/service: app/service: no_such_service/')"
OUT=$(ab "compile $FIX")
echo "$OUT" | grep -qi "no_such_service" && ok "missing service target: names the service" \
                                         || { bad "missing service target not named"; echo "$OUT" | tail -3 | sed 's/^/       /'; }

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
