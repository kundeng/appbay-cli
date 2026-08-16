#!/usr/bin/env bash
# S27 / issue #74 — the public install journey.
#
# A stranger finds Appbay, runs the documented command, and ends up with a working install.
# No token, no gh login, no membership. That is the whole property.
#
# 🚨 THIS SCRIPT IS EXPECTED TO FAIL UNTIL S27 P2 LANDS, AND THAT FAILURE IS THE POINT.
# `kundeng/appbay` is private today, so every URL below returns 404 for an anonymous
# caller. Measured 2026-08-15: raw install.sh, /releases/latest, /releases?per_page=1, the
# asset download, and the catalog clone — all 404. A red run here is the defect reproducing,
# not a broken harness.
#
# ⭐ THE POINT IS THAT IT IS ONE SITTING ON ONE MACHINE. Three separate green checks on
# three machines would not prove this: an install that succeeds and then cannot fetch a
# catalog is a failed journey, and the only way to see that is to keep going on the same
# host. R3.4 exists because the pieces were previously verified apart and the seam between
# them was never walked.
#
# 🚨 NO CREDENTIALS IS ASSERTED, NOT ASSUMED. The harness first PROVES the target has no
# usable auth — an inherited GITHUB_TOKEN or a cached gh login would make every check below
# pass while telling us nothing about a stranger. That control runs first and aborts.
#
#   VM=appbay-public-test ./s27-journey-public-install.sh
#   PUBLIC_REPO=kundeng/appbay CATALOG_REPO=kundeng/appbay-catalog ./s27-journey-public-install.sh
#
# Use a FRESH VM. A host that already has ~/.appbay, a binary on PATH, or a warm image
# cannot distinguish "install worked" from "install was already here".

set -uo pipefail
VM="${VM:-appbay-public-test}"
PRIV="${PRIV:-env}"
PUBLIC_REPO="${PUBLIC_REPO:-kundeng/appbay}"
CATALOG_REPO="${CATALOG_REPO:-kundeng/appbay-catalog}"
BRANCH="${BRANCH:-master}"
HOME_DIR="${HOME_DIR:-/home/ubuntu/.appbay}"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }

echo "== S27 public install journey =="
echo "   VM=$VM  repo=$PUBLIC_REPO  catalog=$CATALOG_REPO"
echo

# ---------------------------------------------------------------------------------------
# CONTROL — prove the target is credential-free before trusting anything downstream.
# ---------------------------------------------------------------------------------------
echo "-- control: the target has no usable credentials"

if vm 'env | grep -qiE "GITHUB_TOKEN|GH_TOKEN"'; then
  bad "target has GITHUB_TOKEN/GH_TOKEN in its environment — every check below would be vacuous"
  echo; echo "0 passed, 1 failed"; exit 1
fi
ok "no GITHUB_TOKEN/GH_TOKEN in the environment"

if vm 'test -f ~/.config/gh/hosts.yml || test -f ~/.git-credentials'; then
  bad "target has cached git/gh credentials — a stranger has none"
  echo; echo "0 passed, 1 failed"; exit 1
fi
ok "no cached gh or git credentials"

# A fresh host, or we cannot tell an install from a pre-existing one.
if vm "test -e $HOME_DIR || command -v appbay"; then
  bad "target already has $HOME_DIR or appbay on PATH — use a fresh VM"
  echo; echo "0 passed, 1 failed"; exit 1
fi
ok "no prior install on the target"

# ---------------------------------------------------------------------------------------
# R3.1 — the documented command completes.
# ---------------------------------------------------------------------------------------
echo
echo "-- R3.1: curl | sh completes with no credentials"

INSTALL_URL="https://raw.githubusercontent.com/$PUBLIC_REPO/$BRANCH/scripts/install.sh"

# Fetch first and check the STATUS, so a 404 reports as a 404 rather than as `sh` being fed
# an HTML error page — which is how this fails today and reads as a shell syntax error.
code=$(vm "curl -s -o /tmp/install.sh -w '%{http_code}' '$INSTALL_URL'")
if [ "$code" != "200" ]; then
  bad "install.sh is not anonymously reachable — HTTP $code at $INSTALL_URL"
  echo "     (expected until S27 P2; the repo is private)"
else
  ok "install.sh reachable anonymously (HTTP 200)"

  if vm "sh /tmp/install.sh >/tmp/install.log 2>&1"; then
    ok "installer exited 0"
  else
    bad "installer failed — $(vm 'tail -3 /tmp/install.log' | tr '\n' ' ')"
  fi

  if vm "test -x $HOME_DIR/bin/appbay"; then
    ok "binary installed at $HOME_DIR/bin/appbay"
  else
    bad "no binary at $HOME_DIR/bin/appbay after install"
  fi

  # The version must be the release tag, not the build-time fallback. This is the bug
  # fixed in b1a5c84 — every binary before it reported 0.1.0-dev, which also broke
  # `appbay update`'s comparison against the latest tag.
  ver=$(vm "$HOME_DIR/bin/appbay --version 2>/dev/null")
  case "$ver" in
    ""|*dev*) bad "binary reports '$ver' — the tag was not injected at compile time" ;;
    *)        ok "binary reports a real version: $ver" ;;
  esac
fi

# ---------------------------------------------------------------------------------------
# R3.2 — init fetches the catalog. Same machine, same sitting.
# ---------------------------------------------------------------------------------------
echo
echo "-- R3.2: appbay init fetches the catalog with no credentials"

code=$(vm "curl -s -o /dev/null -w '%{http_code}' 'https://api.github.com/repos/$CATALOG_REPO'")
if [ "$code" != "200" ]; then
  bad "catalog repo not anonymously readable — HTTP $code for $CATALOG_REPO"
  echo "     (S27 task 3.4 makes it public; scanned 2026-08-15, 300 entries, no secrets)"
else
  ok "catalog repo anonymously readable"

  if vm "cd /home/ubuntu && $HOME_DIR/bin/appbay init >/tmp/init.log 2>&1"; then
    ok "appbay init exited 0"
  else
    bad "appbay init failed — $(vm 'tail -3 /tmp/init.log' | tr '\n' ' ')"
  fi

  # Assert entries landed, not merely that the command was cheerful. An init that clones
  # nothing and reports success is exactly the shape this project keeps finding.
  n=$(vm "cd /home/ubuntu && $HOME_DIR/bin/appbay catalog list 2>/dev/null | grep -cE '^[a-z0-9-]+' || echo 0")
  if [ "${n:-0}" -gt 0 ]; then
    ok "catalog populated ($n entries listed)"
  else
    bad "catalog is empty after init — the fetch reported success and delivered nothing"
  fi
fi

# ---------------------------------------------------------------------------------------
# R3.3 — self-update finds a release.
# ---------------------------------------------------------------------------------------
echo
echo "-- R3.3: appbay update finds the latest release with no credentials"

# /releases/latest 404s for a repo whose releases are ALL pre-releases, which is the state
# today. install.sh and update.ts both fall back to /releases?per_page=1; the fallback is
# what actually has to work, so check it directly rather than trusting the happy path.
code=$(vm "curl -s -o /dev/null -w '%{http_code}' 'https://api.github.com/repos/$PUBLIC_REPO/releases?per_page=1'")
if [ "$code" != "200" ]; then
  bad "release list not anonymously readable — HTTP $code"
else
  ok "release list anonymously readable"
  out=$(vm "cd /home/ubuntu && $HOME_DIR/bin/appbay update --check 2>&1 || true")
  case "$out" in
    *"No releases found"*|*"404"*|*"error"*|*"Error"*)
      bad "appbay update could not resolve a release: $(echo "$out" | head -1)" ;;
    "") bad "appbay update produced no output" ;;
    *)  ok "appbay update resolved a release" ;;
  esac
fi

# ---------------------------------------------------------------------------------------
# R3.5 — the private set stayed private. Checked against the PUBLISHED repo, not our tree.
# ---------------------------------------------------------------------------------------
echo
echo "-- R3.5: no private path is present in the published repo"

tmp=$(mktemp -d)
if git clone -q --depth 50 "https://github.com/$PUBLIC_REPO" "$tmp/pub" 2>/dev/null; then
  leaked=0
  # Every commit's tree, not just the tip — a file deleted at HEAD is still published.
  for c in $(git -C "$tmp/pub" rev-list --all); do
    if git -C "$tmp/pub" ls-tree -r --name-only "$c" \
        | grep -qE '^(apps/web|apps/desktop|\.kiro|work-notes)/|^(CLAUDE|agents|README-INTERNAL)\.md$|^docker-compose\.server\.yml$'; then
      bad "private path present in commit ${c:0:8}"
      leaked=1
      break
    fi
  done
  [ "$leaked" -eq 0 ] && ok "no private path in any published commit"
else
  bad "could not clone $PUBLIC_REPO anonymously"
fi
rm -rf "$tmp"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
