#!/usr/bin/env bash
# Appbay local dev environment provisioning.
#
# Verifies the OrbStack VM used for local dev/testing is up and running, starts it
# if it is stopped, and confirms the appbay toolchain + Caddy Security edge are
# healthy on it. This is the "is my dev box ready?" gate you run before starting
# local dev work, not a CI validation (that is scripts/test-vm.sh).
#
# Usage:
#   bash scripts/dev-env.sh
#
# Environment overrides:
#   APPBAY_DEV_VM     OrbStack machine name (default: appbay-e2e-f43)
#   APPBAY_DEV_START  Set to 0 to fail instead of starting a stopped VM (default: 1)
#
# Exit codes:
#   0  dev environment ready
#   1  a required check failed (OrbStack down, VM missing, toolchain broken)

set -euo pipefail

VM_NAME="${APPBAY_DEV_VM:-appbay-e2e-f43}"
AUTO_START="${APPBAY_DEV_START:-1}"

PASS=0
FAIL=0

pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ FAIL: $*" >&2; FAIL=$((FAIL + 1)); }
section() { echo ""; echo "── $* ──────────────────────────────────────"; }

# ── Preflight: orb CLI ────────────────────────────────────────────────────────

section "Preflight"

if ! command -v orb >/dev/null 2>&1; then
  echo "Error: 'orb' (OrbStack CLI) not found on PATH." >&2
  echo "  Install OrbStack from https://orbstack.dev and ensure the CLI is available." >&2
  exit 1
fi
pass "orb CLI available"

# ── OrbStack running? ─────────────────────────────────────────────────────────

section "OrbStack"

if ! orb status >/dev/null 2>&1; then
  echo "Error: OrbStack is not running. Start the OrbStack app first." >&2
  exit 1
fi
pass "OrbStack is running"

# ── Dev VM present and running ────────────────────────────────────────────────

section "Dev VM (${VM_NAME})"

VM_STATE="$(orb list 2>/dev/null | awk -v vm="${VM_NAME}" '$1 == vm { print $2 }')"

if [ -z "${VM_STATE}" ]; then
  echo "Error: OrbStack machine '${VM_NAME}' does not exist." >&2
  echo "  Create it with: orbctl create ${VM_NAME} --image fedora:43" >&2
  exit 1
fi

if [ "${VM_STATE}" = "running" ]; then
  pass "VM ${VM_NAME} is running"
elif [ "${VM_STATE}" = "stopped" ]; then
  if [ "${AUTO_START}" = "1" ]; then
    echo "  VM ${VM_NAME} is stopped — starting it..."
    orbctl start "${VM_NAME}" >/dev/null 2>&1
    # Give the machine a moment to boot before probing it.
    for _ in $(seq 1 30); do
      if orb list 2>/dev/null | awk -v vm="${VM_NAME}" '$1 == vm && $2 == "running" { found=1 } END { exit !found }'; then
        break
      fi
      sleep 1
    done
    if orb list 2>/dev/null | awk -v vm="${VM_NAME}" '$1 == vm && $2 == "running" { found=1 } END { exit !found }'; then
      pass "VM ${VM_NAME} started"
    else
      fail "VM ${VM_NAME} did not reach 'running' within 30s"
    fi
  else
    fail "VM ${VM_NAME} is stopped (APPBAY_DEV_START=0)"
  fi
else
  fail "VM ${VM_NAME} is in unexpected state '${VM_STATE}'"
fi

# ── VM IP ─────────────────────────────────────────────────────────────────────

VM_IP="$(orb info "${VM_NAME}" 2>/dev/null | awk -F': ' '/^IPv4/ { print $2 }')"
if [ -n "${VM_IP}" ]; then
  pass "VM IP: ${VM_IP}"
else
  fail "could not read VM IPv4 address"
fi

# ── appbay toolchain on the VM ────────────────────────────────────────────────

section "appbay toolchain on VM"

APPBAY_BIN="$(orb run -m "${VM_NAME}" bash -c 'command -v appbay' 2>/dev/null || true)"
if [ -n "${APPBAY_BIN}" ]; then
  APPBAY_VER="$(orb run -m "${VM_NAME}" bash -c 'appbay --version' 2>/dev/null || true)"
  pass "appbay binary at ${APPBAY_BIN} (${APPBAY_VER:-version unknown})"
else
  fail "appbay binary not found on VM — install it (e.g. via the install script) before dev work"
fi

# ── Container runtime (matches prod: podman) ─────────────────────────────────

section "Container runtime (podman)"

PODMAN_VER="$(orb run -m "${VM_NAME}" bash -c 'podman --version' 2>/dev/null || true)"
if [ -n "${PODMAN_VER}" ]; then
  pass "podman: ${PODMAN_VER}"
else
  fail "podman not installed on VM — install it (sudo dnf install -y podman) to match the prod runtime"
fi

PODMAN_SOCK="$(orb run -m "${VM_NAME}" bash -c 'test -S /run/podman/podman.sock && echo yes || echo no' 2>/dev/null || true)"
if [ "${PODMAN_SOCK}" = "yes" ]; then
  pass "podman.socket listening at /run/podman/podman.sock"
else
  fail "podman.socket not enabled — run: sudo systemctl enable --now podman.socket"
fi

# ── Caddy Security edge healthy ───────────────────────────────────────────────

section "Caddy Security edge"

CADDY_UP="$(orb run -m "${VM_NAME}" bash -c 'docker ps --filter name=appbay.caddy.caddy --format "{{.Status}}"' 2>/dev/null || true)"
if [ -n "${CADDY_UP}" ]; then
  pass "Caddy Security edge: ${CADDY_UP}"
else
  fail "Caddy Security edge container (appbay.caddy.caddy) is not running"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "── Summary ──────────────────────────────────────────────────────────"
echo "  ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
  echo "  Dev environment NOT ready."
  exit 1
fi
echo "  Dev environment ready. VM ${VM_NAME} at ${VM_IP:-<unknown>}."
