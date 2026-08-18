#!/usr/bin/env bash
# S28 / issue #73 — the installer refuses a download it cannot vouch for.
#
# `scripts/install.sh` fetches ~90MB and then executes it. It now fetches SHA256SUMS and
# checks the binary against it — but a check that is merely PRESENT proves nothing. The
# acceptance criterion on #73 is specifically that the FAILURE path works: a deliberately
# corrupted download must abort the install, not merely be noticed.
#
# ⭐ THE CONTROL IS THE POINT. R4 runs the identical local-server harness with an
# UNCORRUPTED payload and requires it to succeed. Without it, R2 and R3 passing would be
# indistinguishable from the harness being broken — a local server that 404s makes every
# "refused to install" check pass while testing nothing.
#
#   VM=appbay-public-test ./s28-journey-install-integrity.sh
#   VM=appbay-public-test TAG=v0.0.1-alpha.6 ./s28-journey-install-integrity.sh
#
# Safe on a VM that already has appbay: every install here is redirected with
# APPBAY_INSTALL_DIR into a scratch directory and never touches the real one.

set -uo pipefail
VM="${VM:-appbay-integrity-journey-$$}"
DELETE_VM="${DELETE_VM:-1}"
# Ephemeral VM launched for this run when the named VM does not already exist.
EPHEMERAL=0
PRIV="${PRIV:-env}"
REPO="${REPO:-kundeng/appbay-cli}"
BRANCH="${BRANCH:-main}"
TAG="${TAG:-}"
PORT="${PORT:-8099}"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }

# --- ephemeral-VM bootstrap: the fresh host this journey's whole point needs ------------
if ! multipass info "$VM" >/dev/null 2>&1; then
  echo "-- launching an ephemeral VM: $VM"
  multipass launch --name "$VM" --cpus 2 --mem 3G --disk 10G >/dev/null 2>&1 \
    || { echo "❌ could not launch multipass VM $VM"; exit 1; }
  EPHEMERAL=1
fi
cleanup_vm() {
  if [ "$EPHEMERAL" -eq 1 ] && [ "$DELETE_VM" = "1" ]; then
    multipass delete "$VM" --purge >/dev/null 2>&1 || true
  fi
}
trap cleanup_vm EXIT
# Wait for SSH/network to be ready before `multipass exec`.
for _ in $(seq 1 30); do
  multipass exec "$VM" -- true >/dev/null 2>&1 && break
  sleep 2
done
# --- end ephemeral bootstrap -------------------------------------------------------------

echo "== S28 install-integrity journey =="
echo "   VM=$VM  repo=$REPO"
echo

# The whole payload runs INSIDE the VM. Driving this over `multipass exec` one line at a
# time turns into three levels of quoting; transferring a script is the readable form.
# ⚠️ Staging this file has two snap traps, both measured on 2026-08-16, and both of which
# surface as an unhelpful transfer error rather than as a permission problem:
#   /tmp             -> "[sftp] cannot access /tmp/...: No such file or directory"
#   a DOTFILE in $HOME -> "[sftp] cannot open local file ...: Permission denied"
# multipass ships as a snap, and the `home` interface grants access to non-hidden files in
# $HOME only. So: $HOME, and no leading dot.
PAYLOAD="$(mktemp -p "$HOME" appbay-journey-payload.XXXXXX)"
cat > "$PAYLOAD" <<PAYLOAD_EOF
#!/usr/bin/env bash
set -uo pipefail
REPO="$REPO"
BRANCH="$BRANCH"
TAG="$TAG"
PORT="$PORT"
PAYLOAD_EOF
cat >> "$PAYLOAD" <<'PAYLOAD_EOF'

W=$(mktemp -d); cd "$W" || exit 1
r() { printf '%s\n' "$*"; }        # one machine-readable result line per check

# --- fixtures -------------------------------------------------------------------------
curl -fsSL "https://raw.githubusercontent.com/$REPO/$BRANCH/scripts/install.sh" -o install.sh \
  || { r "SETUP fail could-not-fetch-installer"; exit 1; }

if [ -z "$TAG" ]; then
  TAG=$(curl -sSL "https://api.github.com/repos/$REPO/releases?per_page=1" \
        | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
fi
[ -n "$TAG" ] || { r "SETUP fail no-release-tag"; exit 1; }

curl -fsSL "https://github.com/$REPO/releases/download/$TAG/appbay-linux-x64" -o real.bin \
  || { r "SETUP fail could-not-fetch-binary"; exit 1; }
REAL_SHA=$(sha256sum real.bin | awk '{print $1}')
SIZE=$(stat -c%s real.bin)
r "SETUP ok tag=$TAG sha=${REAL_SHA:0:16} size=$SIZE"

# Corrupt: same length, one byte different in the middle. A length-preserving edit is the
# harder case — anything keying on Content-Length would miss it.
cp real.bin corrupt.bin
MID=$((SIZE / 2))
printf '\xde' | dd of=corrupt.bin bs=1 seek="$MID" count=1 conv=notrunc status=none
cmp -s real.bin corrupt.bin && { r "SETUP fail corruption-was-a-no-op"; exit 1; }

# Truncated: the partial-download case named in the issue.
head -c $((SIZE / 3)) real.bin > short.bin

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$W"' EXIT
for _ in $(seq 1 40); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/real.bin" -r 0-0 2>/dev/null && break
  sleep 0.25
done

# run_case <name> <install-dir> <env...> -- returns rc, leaves log in $W/<name>.log
run_case() {
  local name=$1; shift
  local dir="$W/dest-$name"
  mkdir -p "$dir"
  env APPBAY_INSTALL_DIR="$dir" "$@" sh install.sh > "$W/$name.log" 2>&1
  local rc=$?
  # `installed` = did a binary actually land in the scratch dir
  local installed=no
  [ -e "$dir/appbay" ] && installed=yes
  echo "$rc $installed"
}

# --- R1: the real release installs and says so ----------------------------------------
read -r rc installed <<<"$(run_case happy APPBAY_VERSION="$TAG")"
if [ "$rc" -eq 0 ] && [ "$installed" = yes ] && grep -q "Checksum verified" "$W/happy.log"; then
  r "R1 ok real-release-installs-and-verifies"
else
  r "R1 fail rc=$rc installed=$installed :: $(tail -2 "$W/happy.log" | tr '\n' ' ')"
fi

# --- R4 (control, run early): the harness itself can succeed --------------------------
read -r rc installed <<<"$(run_case control \
  APPBAY_BINARY_URL="http://127.0.0.1:$PORT/real.bin" APPBAY_SHA256="$REAL_SHA")"
if [ "$rc" -eq 0 ] && [ "$installed" = yes ]; then
  r "R4 ok control-uncorrupted-payload-installs"
else
  r "R4 fail control-could-not-install rc=$rc installed=$installed :: $(tail -2 "$W/control.log" | tr '\n' ' ')"
fi

# --- R2: a length-preserving corruption is refused ------------------------------------
read -r rc installed <<<"$(run_case corrupt \
  APPBAY_BINARY_URL="http://127.0.0.1:$PORT/corrupt.bin" APPBAY_SHA256="$REAL_SHA")"
if [ "$rc" -ne 0 ] && [ "$installed" = no ] && grep -q "Checksum mismatch" "$W/corrupt.log"; then
  r "R2 ok corrupted-download-refused rc=$rc"
else
  r "R2 fail rc=$rc installed=$installed :: $(tail -2 "$W/corrupt.log" | tr '\n' ' ')"
fi

# --- R3: a truncated download is refused ----------------------------------------------
read -r rc installed <<<"$(run_case short \
  APPBAY_BINARY_URL="http://127.0.0.1:$PORT/short.bin" APPBAY_SHA256="$REAL_SHA")"
if [ "$rc" -ne 0 ] && [ "$installed" = no ] && grep -q "Checksum mismatch" "$W/short.log"; then
  r "R3 ok truncated-download-refused rc=$rc"
else
  r "R3 fail rc=$rc installed=$installed :: $(tail -2 "$W/short.log" | tr '\n' ' ')"
fi

# --- R5: no digest available is a REFUSAL, not a silent downgrade ---------------------
# The override path deliberately skips when the caller supplies no digest, and it must SAY
# so — a silent skip is how an unverified install gets inherited rather than chosen.
read -r rc installed <<<"$(run_case nodigest APPBAY_BINARY_URL="http://127.0.0.1:$PORT/real.bin")"
if grep -q "Skipping checksum verification" "$W/nodigest.log"; then
  r "R5 ok unverified-install-is-announced"
else
  r "R5 fail no-announcement rc=$rc :: $(tail -2 "$W/nodigest.log" | tr '\n' ' ')"
fi
PAYLOAD_EOF

multipass transfer "$PAYLOAD" "$VM:/tmp/install-integrity.sh" >/dev/null 2>&1 || {
  echo "  ❌ could not transfer the payload to $VM — is the VM running?"; exit 1; }
rm -f "$PAYLOAD"

OUT="$(vm 'bash /tmp/install-integrity.sh' 2>&1)"

while IFS= read -r line; do
  case "$line" in
    "SETUP ok"*)  echo "-- fixtures: ${line#SETUP ok }" ;;
    *" ok "*)     ok  "${line%% ok *}: $(echo "$line" | sed 's/^[^ ]* ok //')" ;;
    *" fail "*)   bad "${line%% fail *}: $(echo "$line" | sed 's/^[^ ]* fail //')" ;;
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
