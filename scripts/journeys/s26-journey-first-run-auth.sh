#!/usr/bin/env bash
# S26 / issue #60 journey 2 — first-run admin setup, login, logout, invalid/expired session.
#
# ⭐ THIS IS THE ONE JOURNEY THAT CANNOT BE PROVEN FROM THE CLI. Setup and session handling
# live entirely in the web control plane, and the alpha ledger's evidence standard rules out
# "I walked it in a browser once" — so it is driven by agent-browser against a real server
# and a throwaway install.
#
# 🚨 THE NEGATIVE CASES ARE THE POINT. A login form that accepts the right password proves
# very little; one that also accepts the WRONG password, or that keeps serving a session
# after it was invalidated, is a security defect that looks perfect in a screenshot. Both
# are asserted here.
#
# Runs locally (not in a VM): needs the repo, node/pnpm and agent-browser.
#   ./s26-journey-first-run-auth.sh

set -uo pipefail
# 🚨 DERIVED FROM THIS SCRIPT'S OWN LOCATION, never a hardcoded checkout path. This read
# `$HOME/src/appbay` until 2026-08-16 — a directory that stopped existing when the three
# scattered checkout roots were consolidated into ~/Projects on 2026-08-15. The journey then
# ran `$REPO/apps/cli/dist/appbay init` against a path with no binary, swallowed the error
# with `>/dev/null 2>&1`, and reported "init did not scaffold" — blaming the product for a
# missing directory. All three local-only journeys had the same line, and because the sweep
# runner SKIPS local-only scripts, none of them had been run since the move.
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PORT="${PORT:-3222}"
SCRATCH="${SCRATCH:-/tmp/appbay-firstrun-journey}"
H="$SCRATCH/home"
USER_NAME="journeyadmin"
GOOD_PW="JourneyPass123!"
BAD_PW="WrongPass999!"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

# 🚨 THIS JOURNEY RUNS ON THE WORKSTATION, so it must leave no trace on it.
# `appbay init --dir X` PERSISTS X to ~/.config/appbay/home — a machine-wide
# default every later appbay command reads. Passing $H there repoints the
# developer's own CLI at $SCRATCH, which the trap below deletes on exit. Use
# APPBAY_HOME instead: init honours it as a runtime override and does not save
# it. See s26-journey-doctor-parity.sh for the incident this prevents.
WS_POINTER="$HOME/.config/appbay/home"
ws_pointer() { if [ -f "$WS_POINTER" ]; then cat "$WS_POINTER"; else echo "<unset>"; fi; }
WS_BEFORE="$(ws_pointer)"

cleanup() {
  agent-browser close --all >/dev/null 2>&1 || true
  for p in $(ss -lptn "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u); do kill "$p" 2>/dev/null || true; done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
cleanup
mkdir -p "$H"

echo "── Start a server on a throwaway install"
APPBAY_HOME="$H" "$REPO/apps/cli/dist/appbay" init --domain journey.test.local --project journey >/dev/null 2>&1
[ "$(ws_pointer)" = "$WS_BEFORE" ] \
  && ok "workstation APPBAY_HOME pointer untouched" \
  || bad "🚨 this journey repointed the workstation: $WS_BEFORE -> $(ws_pointer)"
( cd "$REPO" && APPBAY_HOME="$H" PORT="$PORT" pnpm --filter @appbay/web dev >"$SCRATCH/web.log" 2>&1 & )

snap() { agent-browser snapshot -i -c 2>/dev/null; }
# ⚠️ Find the LINE, then take its ref. An earlier version required `[ref=` to follow the
# label immediately, so `button "Create admin & continue"` never matched — every fill then
# landed on a stale ref and the journey reported the product broken when it was fine.
ref()  { snap | grep -F "$1" | grep -oE 'ref=e[0-9]+' | grep -oE 'e[0-9]+' | head -1; }
# How many interactive elements the browser can actually see. Zero means blind.
# ⚠️ NO `|| echo 0` HERE. `grep -c` already prints `0` when it matches nothing AND exits 1,
# so the fallback fired as well and the function returned "0\n0" — every arithmetic test
# then died with "integer expression expected" and the readiness gate announced
# "the page RENDERED (0\n0 interactive elements visible)". A guard that cannot count is the
# same class of defect as the one this journey is being fixed for.
refcount() { snap | grep -c 'ref=e'; }

# 🚨 A CHECK THAT CANNOT SEE MUST NOT RETURN A VERDICT (issue #78).
#
# Every assertion below infers its verdict from what the browser can see. When the browser
# saw nothing, this journey did not report "I could not see the page" — it reported
# `🚨 a WRONG password was accepted`, and that is worse than a vacuous pass. A vacuous pass
# wastes an opportunity; a vacuous FAILURE sends someone hunting an authentication bypass
# that does not exist, in the area where a false alarm costs the most.
#
# So blindness aborts with exit 2 — a HARNESS fault, deliberately distinct from the exit 1
# this journey uses for a product defect. Same shape as s25-interface-optionality's baseline
# abort: never compare two broken states.
require_rendered() {  # $1 = the assertion we were about to make
  local n; n=$(refcount)
  [ "${n:-0}" -gt 0 ] 2>/dev/null && return 0
  echo "  ⛔ HARNESS ABORT: the page never rendered — cannot judge \"$1\"."
  echo "     Continuing would attribute a blind harness to the product."
  tail -5 "$SCRATCH/web.log" 2>/dev/null | sed 's/^/       web.log: /'
  exit 2
}

# ⚠️ A 200 IS NOT READINESS, AND THAT IS THE WHOLE BUG. A Next.js DEV server answers 200
# long before the route is compiled and hydrated. Measured 2026-08-16: http=200, body 13843
# bytes, `agent-browser snapshot -c` EMPTY, console repeating `[HMR] connected` /
# `[Fast Refresh] rebuilding`. The old gate polled only the status code and then ran six
# assertions against a page the browser could not see — 2 passed, 6 failed, none about the
# product.
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" 2>/dev/null)" = "200" ] && break
  sleep 2
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" 2>/dev/null)" = "200" ] \
  && ok "server answers on :$PORT" || { bad "server did not start"; exit 1; }

# Stage 2 — wait for RENDERED CONTENT, not for a status code.
#
# ⚠️ TWO CONSECUTIVE NON-EMPTY POLLS, not one. A single ref can appear on a page that is
# still compiling (measured against a deliberately blank decoy page, which intermittently
# yielded one ref and then none). Requiring the count to hold across two polls two seconds
# apart distinguishes "rendered" from "flickering".
RENDERED=0
SEEN=0
N=0
for _ in $(seq 1 30); do
  agent-browser open "http://localhost:$PORT/" >/dev/null 2>&1
  N=$(refcount)
  if [ "${N:-0}" -gt 0 ] 2>/dev/null; then
    SEEN=$((SEEN + 1))
    if [ "$SEEN" -ge 2 ]; then RENDERED=1; break; fi
  else
    SEEN=0
  fi
  sleep 2
done
if [ "$RENDERED" = "1" ]; then
  ok "the page RENDERED ($N interactive elements visible, stable across two polls)"
else
  echo "  ⛔ HARNESS ABORT: the server answered 200 but the page never rendered."
  echo "     No assertion in this journey can produce a product verdict from a blank page."
  tail -5 "$SCRATCH/web.log" 2>/dev/null | sed 's/^/       web.log: /'
  exit 2
fi

echo "── A fresh install must demand setup, not offer a login"
require_rendered "fresh install shows first-run setup"
S=$(snap)
echo "$S" | grep -qi "Create admin" && ok "fresh install shows first-run setup" \
                                    || { bad "fresh install did not show setup"; echo "$S" | head -4 | sed 's/^/       /'; }

echo "── Create the first admin"
require_rendered "setup completes and hands off to sign-in"
U=$(ref 'textbox "USERNAME"'); P=$(ref 'textbox "PASSWORD"'); C=$(ref 'textbox "CONFIRM"'); B=$(ref 'button "Create admin')
agent-browser fill "@$U" "$USER_NAME" >/dev/null 2>&1
agent-browser fill "@$P" "$GOOD_PW" >/dev/null 2>&1
agent-browser fill "@$C" "$GOOD_PW" >/dev/null 2>&1
agent-browser click "@$B" >/dev/null 2>&1; sleep 5
snap | grep -qi "Sign in" && ok "setup completes and hands off to sign-in" || bad "setup did not lead to a sign-in form"
[ -f "$H/etc/control-plane/users.yaml" ] && ok "users.yaml written by setup" || bad "no users.yaml after setup"
MODE=$(stat -c %a "$H/etc/control-plane/users.yaml" 2>/dev/null)
[ "$MODE" = "600" ] && ok "users.yaml is mode 0600" || bad "users.yaml is mode $MODE"

echo "── A WRONG password must be refused"
# 🚨 The assertion that matters. A form that accepts the right password proves nothing on
# its own — this is the check that separates authentication from a doorbell.
require_rendered "a wrong password is refused"
U=$(ref 'textbox "USERNAME"'); P=$(ref 'textbox "PASSWORD"'); B=$(ref 'button "Sign in"')
agent-browser fill "@$U" "$USER_NAME" >/dev/null 2>&1
agent-browser fill "@$P" "$BAD_PW" >/dev/null 2>&1
agent-browser click "@$B" >/dev/null 2>&1; sleep 4
S=$(snap)
# 🚨 THE BLINDNESS CHECK GOES *AFTER* THE CLICK, NOT ONLY BEFORE IT. This is the assertion
# that raised a false authentication-bypass alarm (#78): "not on the sign-in page" was read
# as "signed in", when the real state was "no page at all". An empty snapshot here is a
# harness fault, and it must never render as a security verdict.
if [ "$(printf '%s' "$S" | grep -c 'ref=e')" -eq 0 ]; then
  echo "  ⛔ HARNESS ABORT: the page went blank after submitting the wrong password."
  echo "     Refusing to report on authentication from an empty snapshot."
  exit 2
fi
echo "$S" | grep -qi "Sign in" && ok "wrong password rejected (still on sign-in)" \
                               || { bad "🚨 a WRONG password was accepted"; echo "$S" | head -5 | sed 's/^/       /'; }

echo "── The correct password must be accepted"
require_rendered "the correct password signs in"
U=$(ref 'textbox "USERNAME"'); P=$(ref 'textbox "PASSWORD"'); B=$(ref 'button "Sign in"')
agent-browser fill "@$U" "$USER_NAME" >/dev/null 2>&1
agent-browser fill "@$P" "$GOOD_PW" >/dev/null 2>&1
agent-browser click "@$B" >/dev/null 2>&1; sleep 6
S=$(snap)
echo "$S" | grep -qiE "Dashboard|Catalog|Deploy" && ok "correct password signs in to the app" \
                                                 || { bad "correct password did not sign in"; echo "$S" | head -5 | sed 's/^/       /'; }

echo "── An invalidated session must stop working"
# Delete the session server-side, exactly as `auth.rotateSession` does, then navigate.
# ⚠️ Reloading the SAME page could be served from cache; navigate to a protected route.
rm -f "$H/var/lib/appbay.db" 2>/dev/null
sqlite3_gone=$?
agent-browser open "http://localhost:$PORT/apps" >/dev/null 2>&1; sleep 5
S=$(snap)
# ⚠️ THE `else` BRANCH USED TO PASS ON A BLANK PAGE. "Neither sign-in nor dashboard" was
# recorded as "no longer renders the app shell" — a vacuous PASS, and the same blindness
# that made the wrong-password check a vacuous FAILURE (#78). An empty snapshot is not
# evidence of re-authentication; it is evidence of nothing.
if [ "$(printf '%s' "$S" | grep -c 'ref=e')" -eq 0 ]; then
  echo "  ⛔ HARNESS ABORT: the protected route rendered nothing at all."
  echo "     A blank page cannot distinguish 'session refused' from 'browser blind'."
  exit 2
elif echo "$S" | grep -qi "Sign in"; then
  ok "an invalidated session forces re-authentication"
elif echo "$S" | grep -qiE "Dashboard|Catalog"; then
  bad "🚨 the app still served a protected route after the session store was destroyed"
else
  ok "protected route no longer renders the app shell (page rendered, app shell absent)"
fi

echo
echo "──────── $pass passed, $fail failed ────────"
[ "$fail" -eq 0 ] || exit 1
