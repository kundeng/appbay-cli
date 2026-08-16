#!/usr/bin/env bash
# S25 task 20 — validate the INSTITUTIONAL ACME config path without issuing a certificate.
#
# ⭐ WHAT THIS CAN AND CANNOT PROVE. Real issuance needs credentials (ACME_EAB_KID,
# ACME_EAB_HMAC, CLOUDFLARE_API_TOKEN) and a public domain, none of which exist here. But
# issuance is the LAST step; everything before it is config, and config is exactly where
# this path has been failing silently. This validates the structure and leaves only the CA
# round-trip unproven — rather than leaving the whole path untested because one part is.
#
# 🚨 THE COMMENTS IN acme.caddy.example DESCRIBE TWO FAILURES THAT LOOK LIKE NETWORK
# PROBLEMS AND ARE NOT:
#   • the file is imported INSIDE the base global options block, so wrapping it in another
#     `{ }` is a syntax error in a file almost nobody enables;
#   • a global `acme_dns` block is SILENTLY IGNORED — config loads clean, certificates just
#     never issue.
# Neither is caught by any existing check: s25-caddy-tree-validate.sh never enables the ACME
# file at all (`grep -c acme` -> 0), so this branch shipped unvalidated.
#
# ⚠️ Runs against a STAGING COPY. The live edge is the only path to every deployed app and
# must not be touched by a validation run.
#
# 🚨 THE `,z` ON THE MOUNT IS LOAD-BEARING ON SELINUX HOSTS. Without it the validating
# container cannot read the staged tree and reports
#     Error: reading config from file: open /etc/caddy/Caddyfile: permission denied
# which reads exactly like the config being invalid. AppBay's own compiler labels its bind
# mounts for this reason; a harness that mounts host paths needs the same treatment, and
# this journey did not have it until it was first run on Fedora.
#
# Usage:  VM=appbay-docker ./s25-acme-config-validate.sh

set -uo pipefail
VM="${VM:-appbay-docker}"
# ⚠️ The container CLI is a parameter. This script predates the runtime matrix; hardcoding
# `docker` made every container call print "docker: command not found" on the Podman host —
# and in a before/after journey that silently produced PASSES (see
# s25-interface-optionality.sh and rule 2 in README.md).
CBIN="${CBIN:-docker}"
# Rootful installs need a privilege prefix. `env` is a deliberate no-op: an empty variable
# collapses to a zero-length argv element and breaks the exec.
PRIV="${PRIV:-env}"

IMAGE="${IMAGE:-localhost/appbay-caddy-security:2.11.4-v1.1.64}"
LIVE="${LIVE:-/home/ubuntu/.appbay/etc/apps/caddy/config}"
STAGE="/tmp/appbay-acme-validate"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
# ⚠️ PRIV applies to EVERY command, not just the container runs. On a rootful install parts
# of the edge config tree are root-owned, so an unprivileged `cp -r` stages an INCOMPLETE
# copy — and the baseline then fails for a reason that has nothing to do with ACME.
vm()  { multipass exec "$VM" -- $PRIV bash -c "$1"; }

# Placeholders only. Every value here is read from process env at deploy time precisely so
# that no secret is written into the config tree.
ACME_ENV='-e ACME_EMAIL=validation@example.invalid \
  -e ACME_CA=https://acme.example.invalid/directory \
  -e ACME_EAB_KID=validation-kid \
  -e ACME_EAB_HMAC=dmFsaWRhdGlvbi1obWFj \
  -e APPBAY_EDGE_TOKEN_SECRET=validation-only-not-a-real-secret'

echo "── Stage a copy of the live edge config"
vm "rm -rf $STAGE && cp -r $LIVE $STAGE && ls $STAGE/global/ 2>/dev/null" >/dev/null 2>&1
HAS_EXAMPLE=$(vm "test -f $STAGE/global/acme.caddy.example && echo yes || echo no" | tr -d '[:space:]')
[ "$HAS_EXAMPLE" = "yes" ] && ok "acme.caddy.example ships in the edge config tree" \
                           || bad "acme.caddy.example missing — operators have nothing to copy"

echo "── Baseline: the tree validates with ACME DISABLED"
# ⚠️ ASSERT ON EXIT STATUS, NEVER ON THE WORD "valid" IN THE OUTPUT. An earlier version of
# this script did `grep -qi valid`, which matched "validation-kid" — a substring of the
# PLACEHOLDER THIS SCRIPT ITSELF PASSES — inside Caddy's error message. It reported a green
# tick over a config Caddy had just rejected outright.
BASE=$(vm "$CBIN run --rm $ACME_ENV -v $STAGE:/etc/caddy:ro,z $IMAGE caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; echo rc=\$?" | tr -d '[:space:]')
[ "$BASE" = "rc=0" ] && ok "baseline config is valid" || bad "baseline invalid ($BASE)"

echo "── Enable institutional ACME exactly as an operator would (drop the .example)"
vm "cp $STAGE/global/acme.caddy.example $STAGE/global/acme.caddy" >/dev/null 2>&1
RC=$(vm "$CBIN run --rm $ACME_ENV -v $STAGE:/etc/caddy:ro,z $IMAGE caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; echo rc=\$?" | tr -d '[:space:]')
if [ "$RC" = "rc=0" ]; then
  ok "config with acme_ca + acme_eab validates"
else
  bad "ACME config does NOT validate — operators enabling it get an edge that will not start"
  vm "$CBIN run --rm $ACME_ENV -v $STAGE:/etc/caddy:ro,z $IMAGE caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -3" | sed 's/^/       /'
fi

# The directives must actually be present in what Caddy adapts — a file that is copied but
# never imported would validate perfectly while doing nothing.
echo "── Confirm the directives are actually ADAPTED, not merely present on disk"
JSON=$(vm "$CBIN run --rm $ACME_ENV -v $STAGE:/etc/caddy:ro,z $IMAGE caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null")
echo "$JSON" | grep -q "acme.example.invalid" && ok "acme_ca reached the adapted config" \
                                             || bad "acme_ca did NOT reach the adapted config — the import is inert"
echo "$JSON" | grep -q "validation-kid" && ok "acme_eab (external account binding) reached the adapted config" \
                                        || bad "acme_eab did NOT reach the adapted config — issuance would be rejected at REGISTRATION"

echo "── Tear down the staging copy"
vm "rm -rf $STAGE" >/dev/null 2>&1
GONE=$(vm "test -d $STAGE && echo present || echo gone" | tr -d '[:space:]')
[ "$GONE" = "gone" ] && ok "staging copy removed" || bad "staging copy left behind at $STAGE"

echo
echo "──────── $pass passed, $fail failed ────────"
echo "  NOT proven here: the CA round-trip. That needs ACME_EAB_KID / ACME_EAB_HMAC and a"
echo "  public domain — absent from env and disk on this workstation."
[ "$fail" -eq 0 ] || exit 1
