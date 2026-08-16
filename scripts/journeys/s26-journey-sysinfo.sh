#!/usr/bin/env bash
# S26 / issue #60 journey 14 — `whoami` protocol fixture and `sysinfo` operator diagnostics.
#
# ⭐ TWO FIXTURES WITH DELIBERATELY DIFFERENT JOBS (issue #59). `whoami` is the narrow
# request/ingress protocol fixture — it proves a request reached a container through the
# edge. `sysinfo` is the richer operator-facing diagnostic stack, and its contract is
# explicitly SCOPED: it reports CONTAINER facts, not host facts.
#
# 🚨 THE SCOPE LIMIT IS A SECURITY PROPERTY, NOT A FEATURE GAP. A diagnostic page is exactly
# the kind of thing that grows a Docker socket mount "just to show a bit more", and then it
# is a remote code execution surface wearing a status page's clothes. This journey asserts
# the absence of a runtime socket and host filesystem mount as hard as it asserts the
# endpoints work.
#
#   VM=appbay-docker ./s26-journey-sysinfo.sh
#   VM=appbay-rhel PRIV=sudo CBIN=podman ./s26-journey-sysinfo.sh

set -uo pipefail
VM="${VM:-appbay-docker}"
PRIV="${PRIV:-env}"
HOME_DIR="${HOME_DIR:-/home/ubuntu/.appbay}"
CBIN="${CBIN:-docker}"
# ⚠️ `appbay.sysinfo.sysinfo`, not the `container_name: appbay.sysinfo` the compose file
# declares. Namespace isolation OVERRIDES an author-declared container_name — which is the
# design (two apps must not be able to collide on a name), but it means the compose file is
# not the place to read the runtime name from.
CTR="appbay.sysinfo.sysinfo"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }
ab()  { vm "cd /home/ubuntu && appbay $1 2>&1"; }

cleanup() { ab "down sysinfo" >/dev/null 2>&1; }
trap cleanup EXIT

echo "── sysinfo ships as a system app and deploys"
vm "test -d $HOME_DIR/etc/apps/sysinfo" >/dev/null 2>&1 && ok "sysinfo is seeded into the apps directory" \
                                                        || { bad "sysinfo is not a seeded system app"; exit 1; }
ab "up sysinfo" >/dev/null 2>&1
# The image is pulled on first deploy and the healthcheck has a start period; poll rather
# than guess a sleep, so a slow host does not read as a broken app.
for _ in $(seq 1 20); do
  [ "$(vm "$CBIN inspect $CTR --format '{{.State.Status}}' 2>/dev/null || echo absent" | tr -d '[:space:]')" = "running" ] && break
  sleep 3
done
STATE=$(vm "$CBIN inspect $CTR --format '{{.State.Status}}' 2>/dev/null || echo absent" | tr -d '[:space:]')
[ "$STATE" = "running" ] && ok "sysinfo is running" || { bad "sysinfo did not start ($STATE)"; exit 1; }

IP=$(vm "$CBIN inspect $CTR --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null | awk '{print \$1}'" | tr -d '[:space:]')
[ -n "$IP" ] && ok "reachable on the shared network ($IP)" || { bad "no container IP"; exit 1; }

echo "── The contracted endpoints answer"
HZ=$(vm "curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://$IP:8080/healthz" | tr -d '[:space:]')
[ "$HZ" = "200" ] && ok "/healthz returns 200" || bad "/healthz returned $HZ"

INFO=$(vm "curl -s --max-time 8 http://$IP:8080/api/info")
echo "$INFO" | python3 -c "import sys,json;json.load(sys.stdin)" >/dev/null 2>&1 \
  && ok "/api/info returns parseable JSON" || { bad "/api/info is not valid JSON"; echo "$INFO" | head -2 | sed 's/^/       /'; }

# Each fact the contract names, checked individually — "returns some JSON" is not the claim.
for field in hostname platform uptime memory; do
  echo "$INFO" | grep -qi "$field" && ok "  reports $field" || bad "  missing contracted field: $field"
done

HTML=$(vm "curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://$IP:8080/" | tr -d '[:space:]')
[ "$HTML" = "200" ] && ok "HTML diagnostic page served" || bad "diagnostic page returned $HTML"

echo "── Scope: container facts only — no host access"
# 🚨 The security property. A diagnostic surface with the runtime socket mounted is a remote
# code execution path, not a status page.
MOUNTS=$(vm "$CBIN inspect $CTR --format '{{json .Mounts}}' 2>/dev/null")
echo "$MOUNTS" | grep -qE "docker\.sock|podman\.sock" && bad "🚨 the runtime socket is mounted into a diagnostic container" \
                                                      || ok "no runtime socket mounted"
echo "$MOUNTS" | grep -qE '"Source":"/(etc|root|home|var/lib)(/|")' && bad "🚨 a host filesystem path is mounted in" \
                                                                    || ok "no host filesystem mount"
echo "$INFO" | grep -qi '"scope"' && echo "$INFO" | grep -qi "container" && ok "declares its scope as container" \
                                                                        || ok "scope field not asserted (contract allows either shape)"

echo "── whoami stays the narrow protocol fixture"
WSTATE=$(vm "$CBIN inspect appbay.whoami.whoami --format '{{.State.Status}}' 2>/dev/null || echo absent" | tr -d '[:space:]')
if [ "$WSTATE" = "running" ]; then
  WIP=$(vm "$CBIN inspect appbay.whoami.whoami --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null | awk '{print \$1}'" | tr -d '[:space:]')
  WOUT=$(vm "curl -s --max-time 8 http://$WIP:80/")
  echo "$WOUT" | grep -qi "Hostname:" && ok "whoami echoes request/protocol facts" || bad "whoami did not return protocol facts"
  echo "$WOUT" | grep -qiE "loadavg|disk|platform" && bad "whoami has grown host diagnostics — that is sysinfo's job" \
                                                   || ok "whoami stays narrow (no diagnostics creep)"
else
  echo "     ⏭ whoami not deployed here; skipping the fixture-separation check"
fi

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
