#!/usr/bin/env bash
# S28 / issue #77 (appbay-cli#1) — a changed source rebuilds, proven by observation.
#
# The fix removed a presence check that keyed on the TAG: if `localhost/x:1` resolved, the
# build was skipped whatever the source said. Deleting that code is not evidence. The
# acceptance criterion is specifically that the RUNNING CONTAINER reflects an edit — not
# that a build command was invoked, and not that the source file changed on disk.
#
# ⭐ THE TAG MUST NOT CHANGE. That is the whole point. If the image name moved between the
# two converges, the second one would rebuild for a trivial reason and this journey would
# pass without touching the bug. R4 asserts the tag is byte-identical across the edit and
# R5 asserts the image ID underneath it is NOT — same name, different bytes, which is
# exactly the state the old code could not see.
#
#   VM=appbay-docker ./s28-journey-build-rebuild.sh
#
# Leaves nothing behind: the scratch APPBAY_HOME, the container and the image are removed
# on exit, pass or fail.

set -uo pipefail
VM="${VM:-appbay-docker}"
PRIV="${PRIV:-env}"
# 🚨 RUNTIME-PORTABLE, because S28 R1.5 makes a journey that only runs on one engine half a
# result. The first version hardcoded `docker` throughout AND ran a bare `appbay init`,
# which on a Podman host defaults to Docker and dies in preflight with
# "Could not determine Compose version / Install or upgrade Docker Compose v2".
CBIN="${CBIN:-docker}"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }

echo "== S28 build-rebuild journey =="
echo "   VM=$VM"
echo

# ⚠️ multipass runs as a snap: its daemon cannot read /tmp, and the `home` interface hides
# DOTFILES. Stage the payload in $HOME under a non-hidden name or the transfer fails with a
# misleading "cannot access / permission denied".
PAYLOAD="$(mktemp -p "$HOME" appbay-journey-payload.XXXXXX)"
cat > "$PAYLOAD" <<PAYLOAD_HEADER
#!/usr/bin/env bash
CBIN="$CBIN"
PAYLOAD_HEADER
cat >> "$PAYLOAD" <<'PAYLOAD_EOF'
set -uo pipefail
r() { printf '%s\n' "$*"; }

W="$HOME/rebuild-journey"
rm -rf "$W"; mkdir -p "$W"
export APPBAY_HOME="$W/home"
APP=buildprobe
IMAGE=localhost/appbay-buildprobe:1
CTR=appbay.$APP.probe

cleanup() {
  "$CBIN" rm -f "$CTR" >/dev/null 2>&1
  "$CBIN" rmi -f "$IMAGE" >/dev/null 2>&1
  rm -rf "$W"
}
trap cleanup EXIT

RUNTIME_FLAG=""
[ "$CBIN" = podman ] && RUNTIME_FLAG="--container-runtime podman"
appbay init $RUNTIME_FLAG >/dev/null 2>&1 || { r "SETUP fail init-failed"; exit 1; }

D="$APPBAY_HOME/etc/apps/$APP"
mkdir -p "$D"

cat > "$D/docker-compose.yml" <<'EOF'
services:
  probe:
    image: localhost/appbay-buildprobe:1
    build: .
    command: ["sleep", "3600"]
EOF

# The verify command deliberately matches BOTH markers. If it asserted the exact marker it
# would be the thing catching staleness, and this journey would prove verify works rather
# than proving the rebuild happened.
cat > "$D/appbay.yaml" <<'EOF'
project: default
environment: default
upstream:
  source: ./docker-compose.yml
  expose:
    - probe
builds:
  probe:
    image: localhost/appbay-buildprobe:1
    verify:
      command: ["cat", "/marker"]
      contains: "MARKER"
EOF

write_dockerfile() {
  cat > "$D/Dockerfile" <<EOF
FROM docker.io/library/alpine:3.20
RUN echo "$1" > /marker
EOF
}

marker_in_running_container() { "$CBIN" exec "$CTR" cat /marker 2>/dev/null | tr -d '\r\n'; }
image_id() { "$CBIN" image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null; }
image_tag_present() { "$CBIN" image inspect --format '{{index .RepoTags 0}}' "$IMAGE" 2>/dev/null; }

# --- first converge -------------------------------------------------------------------
write_dockerfile MARKER_V1
appbay up "$APP" > "$W/up1.log" 2>&1
RC1=$?
M1="$(marker_in_running_container)"
ID1="$(image_id)"
TAG1="$(image_tag_present)"
if [ "$RC1" -eq 0 ] && [ "$M1" = "MARKER_V1" ]; then
  r "R1 ok first-converge-runs-v1 marker=$M1"
else
  r "R1 fail rc=$RC1 marker='$M1' :: $(tail -3 "$W/up1.log" | tr '\n' ' ')"
  exit 0
fi

# --- edit the source, converge again, WITHOUT touching the tag -------------------------
write_dockerfile MARKER_V2
appbay up "$APP" > "$W/up2.log" 2>&1
RC2=$?
M2="$(marker_in_running_container)"
ID2="$(image_id)"
TAG2="$(image_tag_present)"

if [ "$RC2" -eq 0 ]; then
  r "R2 ok second-converge-exited-0"
else
  r "R2 fail rc=$RC2 :: $(tail -3 "$W/up2.log" | tr '\n' ' ')"
fi

# THE assertion. Before the fix this read MARKER_V1 forever, and the only cure was a
# manual `docker rmi`.
if [ "$M2" = "MARKER_V2" ]; then
  r "R3 ok running-container-reflects-the-edit marker=$M2"
else
  r "R3 fail running-container-still-says '$M2' (expected MARKER_V2) — changed source did not rebuild"
fi

# Controls: same name, different bytes.
if [ -n "$TAG1" ] && [ "$TAG1" = "$TAG2" ]; then
  r "R4 ok tag-unchanged-across-the-edit tag=$TAG2"
else
  r "R4 fail tag-moved '$TAG1' -> '$TAG2' — the rebuild would be trivially explained"
fi

if [ -n "$ID1" ] && [ -n "$ID2" ] && [ "$ID1" != "$ID2" ]; then
  r "R5 ok image-id-changed ${ID1:7:12} -> ${ID2:7:12}"
else
  r "R5 fail image-id-unchanged (${ID1:7:12}) — no new image was produced"
fi

# --- idempotence still holds: no edit, no change --------------------------------------
appbay up "$APP" > "$W/up3.log" 2>&1
M3="$(marker_in_running_container)"
ID3="$(image_id)"
if [ "$M3" = "MARKER_V2" ] && [ "$ID3" = "$ID2" ]; then
  r "R6 ok unedited-converge-is-a-no-op"
else
  r "R6 fail unedited-converge-changed-something marker='$M3' id=${ID3:7:12}"
fi
PAYLOAD_EOF

multipass transfer "$PAYLOAD" "$VM:/tmp/build-rebuild.sh" >/dev/null 2>&1 || {
  echo "  ❌ could not transfer the payload to $VM — is the VM running?"; exit 1; }
rm -f "$PAYLOAD"

OUT="$(vm 'bash /tmp/build-rebuild.sh' 2>&1)"

while IFS= read -r line; do
  case "$line" in
    *" ok "*)   ok  "${line%% ok *}: $(echo "$line" | sed 's/^[^ ]* ok //')" ;;
    *" fail "*) bad "${line%% fail *}: $(echo "$line" | sed 's/^[^ ]* fail //')" ;;
  esac
done <<< "$OUT"

if [ $((pass + fail)) -eq 0 ]; then
  echo "  ❌ the payload produced no result lines — harness fault, not a product verdict"
  echo "$OUT" | tail -15
  fail=1
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
