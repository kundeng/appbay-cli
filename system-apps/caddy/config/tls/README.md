# Per-site TLS configuration

Files here are imported INTO every site block the ingress trait emits
(`import /etc/caddy/tls/*.caddy`), so they may contain only directives that are legal
inside a site block — a `tls { … }` directive, typically.

🚨 **DO NOT put DNS-01 config in a global `acme_dns` block instead.** Caddy SILENTLY
IGNORES it: the config loads without complaint and certificates simply never issue by DNS.
Per-site is the only form that works, which is why the import is per-site.

⚠️ `appbay setup` writes `dns01-<provider>.caddy` here when `acme_dns_provider` is set in
`project.yaml` (`appbay init --acme-dns-provider cloudflare`). A hand-written file is
honoured too, but appbay will overwrite the one it manages.

⚠️ The glob matches `*.caddy` only, so `.md` and `.example` files are inert.
