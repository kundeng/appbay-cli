# Caddy Security state

`users.json` is the authoritative local edge-identity store. Caddy Security creates it on
first start from the bootstrap environment and updates it through its identity flows.
AppBay-generated authorization policies live under `policies/` and are imported by the
base Caddyfile.

This directory is independent from AppBay control-plane users and from `vault.enc`.
