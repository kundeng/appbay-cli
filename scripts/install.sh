#!/usr/bin/env sh
# Appbay installer
# Usage: curl -fsSL https://raw.githubusercontent.com/kundeng/appbay-cli/main/scripts/install.sh | sh
set -e

REPO="kundeng/appbay-cli"
BINARY_NAME="appbay"
INSTALL_DIR="${APPBAY_INSTALL_DIR:-}"

# ── Helpers ──────────────────────────────────────────────────────────────────

say()  { printf '\033[1m%s\033[0m\n' "$*" >&2; }
info() { printf '  \033[2m%s\033[0m\n' "$*" >&2; }
ok()   { printf '  \033[32m✓\033[0m  %s\n' "$*" >&2; }
fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required tool not found: $1. Please install it and retry."
  fi
}

# ── Platform detection ────────────────────────────────────────────────────────

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux)  OS_TAG="linux" ;;
    Darwin) OS_TAG="macos" ;;
    *)      fail "Unsupported OS: $OS. Supported: Linux, macOS." ;;
  esac

  case "$ARCH" in
    x86_64 | amd64)          ARCH_TAG="x64" ;;
    aarch64 | arm64 | armv8) ARCH_TAG="arm64" ;;
    *)                        fail "Unsupported architecture: $ARCH. Supported: x64, arm64." ;;
  esac

  PLATFORM="${OS_TAG}-${ARCH_TAG}"
  ASSET_NAME="${BINARY_NAME}-${PLATFORM}"
}

# ── Install directory ─────────────────────────────────────────────────────────

pick_install_dir() {
  if [ -n "$INSTALL_DIR" ]; then
    return
  fi

  # Prefer /usr/local/bin if writable, else ~/.local/bin
  if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    INSTALL_DIR="/usr/local/bin"
  else
    INSTALL_DIR="$HOME/.local/bin"
    mkdir -p "$INSTALL_DIR"
    # Warn if not on PATH
    case ":$PATH:" in
      *":$INSTALL_DIR:"*) ;;
      *) info "Note: $INSTALL_DIR is not in PATH. Add it to your shell profile:" && \
         info "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
    esac
  fi
}

# ── Download ──────────────────────────────────────────────────────────────────

# Build curl auth args if GITHUB_TOKEN is set (required for private repos)
auth_header() {
  if [ -n "$GITHUB_TOKEN" ]; then
    printf '%s' "-H" "Authorization: token $GITHUB_TOKEN"
  fi
}

curl_auth() {
  if [ -n "$GITHUB_TOKEN" ]; then
    curl -fsSL -H "Authorization: token $GITHUB_TOKEN" "$@"
  else
    curl -fsSL "$@"
  fi
}

# Like curl_auth but tolerates HTTP errors (returns body, does not exit on 4xx)
curl_auth_soft() {
  if [ -n "$GITHUB_TOKEN" ]; then
    curl -sSL -H "Authorization: token $GITHUB_TOKEN" "$@"
  else
    curl -sSL "$@"
  fi
}

fetch_latest_version() {
  need curl

  # Skip GitHub API if a direct URL override is provided
  if [ -n "$APPBAY_BINARY_URL" ]; then
    VERSION="${APPBAY_VERSION:-dev}"
    return
  fi

  # APPBAY_VERSION lets users install a specific release (including prereleases)
  if [ -n "$APPBAY_VERSION" ]; then
    VERSION="$APPBAY_VERSION"
    return
  fi

  LATEST_URL="https://api.github.com/repos/${REPO}/releases/latest"
  RELEASE_JSON="$(curl_auth_soft "$LATEST_URL")"

  # Extract tag_name with basic POSIX tools (no jq required)
  VERSION="$(printf '%s' "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"

  # /releases/latest returns 404 for repos with only pre-releases.
  # Fall back to the first release in the list (most recent).
  if [ -z "$VERSION" ]; then
    ALL_URL="https://api.github.com/repos/${REPO}/releases?per_page=1"
    ALL_JSON="$(curl_auth_soft "$ALL_URL")"
    VERSION="$(printf '%s' "$ALL_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  fi

  if [ -z "$VERSION" ]; then
    fail "Could not determine latest release. Check your internet connection or https://github.com/${REPO}/releases"
  fi
}

download_binary() {
  # Allow override for local/CI testing: APPBAY_BINARY_URL=http://host/appbay
  if [ -n "$APPBAY_BINARY_URL" ]; then
    DOWNLOAD_URL="$APPBAY_BINARY_URL"
    VERSION="${VERSION:-dev}"
  else
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET_NAME}"
  fi

  TMP_DIR="$(mktemp -d)"
  TMP_BIN="${TMP_DIR}/${BINARY_NAME}"

  info "Downloading ${ASSET_NAME} ${VERSION:-dev}..."
  if [ -n "$GITHUB_TOKEN" ] && [ -z "$APPBAY_BINARY_URL" ]; then
    # Private repo: get asset ID from API, download via asset API endpoint
    ASSET_URL="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
    RELEASE_DATA="$(curl_auth "$ASSET_URL")"
    # Extract the asset API url (not browser_download_url) for the matching asset
    ASSET_API_URL="$(printf '%s\n' "$RELEASE_DATA" | grep -B5 "\"name\": \"${ASSET_NAME}\"" | grep '"url"' | tail -1 | sed 's/.*"\(https:[^"]*\)".*/\1/')"
    if [ -z "$ASSET_API_URL" ]; then
      rm -rf "$TMP_DIR"
      fail "Asset ${ASSET_NAME} not found in release ${VERSION}"
    fi
    if ! curl -fsSL -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/octet-stream" --progress-bar "$ASSET_API_URL" -o "$TMP_BIN"; then
      rm -rf "$TMP_DIR"
      fail "Download failed: $ASSET_API_URL"
    fi
  else
    if ! curl -fsSL --progress-bar "$DOWNLOAD_URL" -o "$TMP_BIN"; then
      rm -rf "$TMP_DIR"
      fail "Download failed: $DOWNLOAD_URL"
    fi
  fi

  verify_checksum "$TMP_BIN" || { rm -rf "$TMP_DIR"; exit 1; }

  chmod +x "$TMP_BIN"
  echo "$TMP_BIN"
}

# ── Checksum ──────────────────────────────────────────────────────────────────
#
# This script downloads ~90MB and then executes it. Without a published digest there
# is no way for a user, for us, or for a mirror to answer "is this the binary that was
# built?" — and a truncated download would be chmod +x'd and run exactly like a whole
# one (issue #73).

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'          # macOS has no sha256sum
  else
    return 1
  fi
}

# Print the expected digest for $ASSET_NAME, or nothing if it cannot be obtained.
expected_sha256() {
  if [ -n "${APPBAY_SHA256:-}" ]; then
    printf '%s' "$APPBAY_SHA256"
    return 0
  fi

  SUMS_URL="https://github.com/${REPO}/releases/download/${VERSION}/SHA256SUMS"
  if [ -n "$GITHUB_TOKEN" ]; then
    # Private repo: browser_download_url needs auth the API asset endpoint provides.
    REL="$(curl_auth_soft "https://api.github.com/repos/${REPO}/releases/tags/${VERSION}")"
    SUMS_API="$(printf '%s\n' "$REL" | grep -B5 '"name": "SHA256SUMS"' | grep '"url"' | tail -1 | sed 's/.*"\(https:[^"]*\)".*/\1/')"
    [ -n "$SUMS_API" ] || return 0
    SUMS="$(curl -sSL -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/octet-stream" "$SUMS_API" 2>/dev/null)"
  else
    SUMS="$(curl -sSL "$SUMS_URL" 2>/dev/null)"
  fi

  # Anchor on the exact asset name so appbay-linux-x64 cannot match
  # appbay-linux-x64-something.
  printf '%s\n' "$SUMS" | awk -v n="$ASSET_NAME" '$2 == n || $2 == "*" n {print $1; exit}'
}

verify_checksum() {
  BIN_PATH="$1"

  # A direct URL is a local/CI override, not a release. There is nothing authoritative
  # to check against unless the caller supplies one.
  if [ -n "$APPBAY_BINARY_URL" ] && [ -z "${APPBAY_SHA256:-}" ]; then
    info "Skipping checksum verification (APPBAY_BINARY_URL set, no APPBAY_SHA256)"
    return 0
  fi

  ACTUAL="$(sha256_of "$BIN_PATH")" || {
    fail "Neither sha256sum nor shasum is available — cannot verify the download.
  Install one, or set APPBAY_SKIP_CHECKSUM=1 to proceed unverified."
  }

  EXPECTED="$(expected_sha256)"

  if [ -z "$EXPECTED" ]; then
    # Releases published before SHA256SUMS existed have no digest to check against.
    # Refuse by default rather than silently downgrade to the old behaviour — an
    # unverified install should be a choice someone made, not one they inherited.
    if [ "${APPBAY_SKIP_CHECKSUM:-}" = "1" ]; then
      info "No SHA256SUMS published for ${VERSION} — proceeding unverified (APPBAY_SKIP_CHECKSUM=1)"
      return 0
    fi
    fail "No SHA256SUMS published for release ${VERSION}, so the download cannot be verified.
  Re-run with APPBAY_SKIP_CHECKSUM=1 to install anyway."
  fi

  if [ "$EXPECTED" != "$ACTUAL" ]; then
    fail "Checksum mismatch for ${ASSET_NAME} — refusing to install.
  expected: ${EXPECTED}
  actual:   ${ACTUAL}
  The download is corrupt or has been tampered with."
  fi

  ok "Checksum verified (sha256 ${ACTUAL})"
}

# ── Install ───────────────────────────────────────────────────────────────────

install_binary() {
  TMP_BIN="$1"
  DEST="${INSTALL_DIR}/${BINARY_NAME}"

  # Back up existing installation
  if [ -f "$DEST" ]; then
    PREV_VERSION="$("$DEST" --version 2>/dev/null || echo "unknown")"
    info "Replacing existing installation ($PREV_VERSION)"
  fi

  if ! mv "$TMP_BIN" "$DEST" 2>/dev/null; then
    # mv failed — try with sudo
    if command -v sudo >/dev/null 2>&1; then
      info "Requesting sudo to write to $INSTALL_DIR..."
      sudo mv "$TMP_BIN" "$DEST"
      sudo chmod +x "$DEST"
    else
      fail "Cannot write to $INSTALL_DIR (permission denied). Set APPBAY_INSTALL_DIR to a writable path."
    fi
  fi

  chmod +x "$DEST"
}

# ── Verify ────────────────────────────────────────────────────────────────────

verify_install() {
  INSTALLED_VERSION="$("${INSTALL_DIR}/${BINARY_NAME}" --version 2>&1 || echo "")"
  if [ -z "$INSTALLED_VERSION" ]; then
    fail "Installed binary did not run. Try: ${INSTALL_DIR}/${BINARY_NAME} --version"
  fi
  ok "Installed: $INSTALLED_VERSION"
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  say "Installing Appbay..."
  echo ""

  detect_platform
  info "Platform: $PLATFORM"

  pick_install_dir
  info "Install dir: $INSTALL_DIR"

  fetch_latest_version
  info "Version: $VERSION"
  echo ""

  TMP_BIN="$(download_binary)"
  install_binary "$TMP_BIN"
  verify_install
  rm -rf "$(dirname "$TMP_BIN")" 2>/dev/null || true

  echo ""
  say "Appbay installed successfully!"
  echo ""
  printf '  Next steps:\n\n'
  printf '    %s doctor        # check prerequisites (Docker, disk, GPU)\n' "$BINARY_NAME"
  printf '    %s init          # scaffold ~/.appbay and seed system apps\n' "$BINARY_NAME"
  printf '    %s server start  # start the control plane\n' "$BINARY_NAME"
  printf '    %s list          # discover available apps\n' "$BINARY_NAME"
  echo ""
  printf '  Web UI: http://localhost:3000  (after server start)\n'
  printf '  Docs:   https://appbay.dev/docs\n'
  echo ""
}

main "$@"
