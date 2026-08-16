/**
 * Embedded system app definitions.
 *
 * 🚨 GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source of truth is the `system-apps/` directory at the repo root. Regenerate with:
 *
 *     node scripts/generate-system-apps.mjs
 *
 * An edit made here is lost on the next build. An edit made in `system-apps/` without
 * regenerating is caught by the test that runs this script with --check.
 *
 * These definitions are bundled into the compiled binary so that `appbay init` can seed
 * system apps without reading files relative to the source tree — which is unavailable in
 * a bun-compiled binary, where `import.meta.dirname` does not resolve to anything useful.
 */

/** A single system app definition with its file contents. */
export interface SystemAppDef {
  /** App directory name (e.g. "traefik"). */
  name: string;
  /** Map of relative file paths to their string contents. */
  files: Record<string, string>;
}

/** All built-in system app definitions, generated from system-apps/. */
export const SYSTEM_APPS: SystemAppDef[] = [
  {
    name: "caddy",
    files: {
      "appbay.yaml": `project: system
environment: default
collection: [system, infrastructure]
tags:
  tier: system
  role: reverse-proxy

upstream:
  source: ./docker-compose.yml
  expose:
    - caddy

# The supported Caddy mode is always the integrated Caddy Security edge. Both non-core
# modules are pinned and inventory-gated; a stock Caddy image is not a supported fallback.
builds:
  caddy:
    image: localhost/appbay-caddy-security:2.11.4-v1.1.64
    verify:
      command: [caddy, list-modules]
      contains:
        - http.authentication.providers.authorizer
        - dns.providers.cloudflare

services:
  caddy:
    traits:
      # 🚨 THE ACME CREDENTIALS ARRIVE AS PROCESS ENV AND ARE NEVER WRITTEN TO A FILE.
      # \`docker compose config\` prints file contents in cleartext — from both \`\${VAR}\`
      # interpolation and \`env_file:\` — so any config dump, UI panel or log would disclose
      # them. The secrets trait resolves these at deploy time and injects them into the
      # \`compose up\` process only.
      #
      # ⚠️ NO \`?gen=\` ON ANY OF THESE. They are issued by someone else — Cloudflare, or the
      # institutional CA — so generating a value would produce a well-formed credential that
      # authenticates to nothing, and the failure would land at certificate issuance rather
      # than at configuration.
      #
      # ⚠️ A missing secret is not an error here. An install with no DNS-01 and no
      # institutional CA resolves none of these, Caddy sees empty values, and the per-site
      # tls import matches no files — which is the correct behaviour for HTTP-01 or the
      # internal issuer.
      - type: secrets
        provider: vault
        refs:
          APPBAY_EDGE_TOKEN_SECRET: "vault://caddy/EDGE_TOKEN_SECRET?gen=hex:64"
          AUTHP_ADMIN_SECRET: "vault://caddy/BOOTSTRAP_ADMIN_SECRET?gen=password:24"
          CLOUDFLARE_API_TOKEN: "vault://caddy/CLOUDFLARE_API_TOKEN"
          ACME_EMAIL: "vault://caddy/ACME_EMAIL"
          ACME_CA: "vault://caddy/ACME_CA"
          ACME_EAB_KID: "vault://caddy/ACME_EAB_KID"
          ACME_EAB_HMAC: "vault://caddy/ACME_EAB_HMAC"
        optional:
          - CLOUDFLARE_API_TOKEN
          - ACME_EMAIL
          - ACME_CA
          - ACME_EAB_KID
          - ACME_EAB_HMAC
        injection: runtime-env
`,
      "config/Caddyfile": `# Appbay base Caddyfile.
#
# 🚨 THIS FILE IS THE ONLY PLACE (appbay_security_headers) MAY BE DEFINED. Every per-app
# site block emitted by the ingress trait does \`import appbay_security_headers\`, and Caddy
# treats a second definition of the same snippet as a duplicate-definition error. Do not
# copy it into a per-app file.
#
# Per-app site blocks live in config/dynamic/<app>.caddy and are written by the ingress
# trait. Auth fragments live in config/dynamic/auth/<app>-*.caddy and are written by the
# auth trait; the site block imports them with a GLOB, which is valid even when it matches
# nothing — that is what lets an app without an auth trait need no placeholder.

# The global block configures the Caddy Security HTTP handlers and a filesystem-backed local
# identity store. The module serves its own browser login portal; this is not a Caddy
# management dashboard. AppBay generates authorization policies into the imported directory.
{
	order authenticate before respond
	order authorize before basicauth
	import /etc/caddy/global/*.caddy

	security {
		local identity store appbay_local {
			realm local
			path /etc/caddy/security/users.json
		}

		authentication portal appbay_portal {
			crypto default token lifetime 3600
			crypto key sign-verify {$APPBAY_EDGE_TOKEN_SECRET}
			enable identity store appbay_local
			ui {
				theme basic
			}

			# 🚨 WITHOUT THIS BLOCK NOBODY GETS IN. Caddy Security completes the password
			# checkpoint, parks the user at /auth/sandbox/<id>, and never issues a token —
			# so the next request to a gated app logs \`no token found\` and loops back to
			# the portal. Authentication succeeds and access is still impossible, with
			# nothing in the logs naming the cause. Measured on a VM 2026-08-12; adding
			# this changes the landing to /auth/portal and a token is issued.
			transform user {
				match origin local
				action add role authp/user
			}
		}

		import /etc/caddy/security/policies/*.caddy
	}
}

# Optional global ACME settings are imported inside the single global-options block above.
# The glob is valid with no matches, so a local installation needs no placeholder files.
#
# An earlier version of this file carried \`email {$ACME_EMAIL}\` in a global block on the
# assumption that an unset variable degrades harmlessly. It does not — Caddy fails to
# parse:
#
#     Error: adapting config using caddyfile: parsing caddyfile tokens for 'email':
#     wrong argument count or unexpected line ending after 'email', at Caddyfile:22
#
# So a fresh install with no ACME configuration could not start at all. Caddy has no
# conditionals, and an empty env placeholder is an empty TOKEN, not an absent directive.
#
# ⇒ Institutional ACME configuration arrives as a file, through the same import-glob
# mechanism the per-app blocks use — valid when it matches nothing. Drop a file in
# config/global/ to enable it; see global/acme.caddy.example.
# Shared security headers. Mirrors the Traefik middleware the other provider emits, so
# switching providers does not change what a client sees.
(appbay_security_headers) {
	header {
		Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
		X-Content-Type-Options nosniff
		Referrer-Policy same-origin
		X-Robots-Tag "none,noindex,nofollow,noarchive,nosnippet,notranslate,noimageindex"
		-Server
	}
}

# DNS-01 via Cloudflare, for wildcard or internal-only names. Requires an image built with
# \`xcaddy build --with github.com/caddy-dns/cloudflare\` — the stock image does NOT carry
# the module and will fail to parse this directive.
#
# (appbay_dns01) {
# 	tls {
# 		dns cloudflare {$CLOUDFLARE_API_TOKEN}
# 	}
# }

# Per-app site blocks, written by the ingress trait. The glob is valid with zero matches,
# so a fresh install with no apps deployed still starts.
import /etc/caddy/dynamic/*.caddy
`,
      "config/Dockerfile.cloudflare": `# AppBay's integrated Caddy Security edge.
#
# 🚨 MULTI-STAGE, AND THAT MATTERS FOR THE RUNTIME. \`community.docker.docker_image_build\`
# is buildx by definition and buildx drives the daemon's BuildKit gRPC endpoints; Podman
# serves the classic POST /build and no BuildKit. Build this with \`podman build\`, which
# uses buildah and handles multi-stage natively — verified by the substrate playbook's
# build probe.
#
# Version pins are part of the release contract. Never replace them with @latest: the
# Caddyfile directive surface is module-version-sensitive and must be VM-tested as a unit.
ARG CADDY_VERSION=2.11.4
FROM docker.io/library/caddy:\${CADDY_VERSION}-builder-alpine AS builder
RUN xcaddy build \${CADDY_VERSION} \\
    --with github.com/greenpau/caddy-security@v1.1.64 \\
    --with github.com/caddy-dns/cloudflare@v0.2.4

ARG CADDY_VERSION=2.11.4
FROM docker.io/library/caddy:\${CADDY_VERSION}-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
`,
      "config/dynamic/README.md": `# Generated routes

AppBay writes one Caddy site block per manifest ingress trait into this directory. These
generated files are validated and reloaded as a complete Caddy configuration.
`,
      "config/dynamic/auth/README.md": `# Generated authentication routes

AppBay writes Caddy Security authentication fragments here for manifests carrying an auth
trait. Route declarations remain owned by the AppBay manifest, not by this directory.
`,
      "config/global/acme.caddy.example": `# Institutional ACME — copy to acme.caddy (drop the .example) to enable.
#
# ⚠️ THIS FILE IS IMPORTED INSIDE THE BASE GLOBAL OPTIONS BLOCK, so it contains option
# directives only. Do not wrap it in another \`{ ... }\` block.
#
# InCommon and other institutional CAs require EXTERNAL ACCOUNT BINDING. Without
# acme_eab the directory rejects the account outright, so certificates never issue —
# and the failure is at REGISTRATION, not renewal, which makes it look like a network
# problem rather than a configuration one.
#
# ⚠️ Every value here is a placeholder read from process env at deploy time. Do not
# write secrets into this file: \`docker compose config\` prints file contents in
# cleartext, and appbay injects process env precisely so that it does not have to.
email {$ACME_EMAIL}
acme_ca {$ACME_CA}

# 🚨 acme_eab TAKES A BLOCK, NOT TWO INLINE ARGUMENTS. This shipped as
#     acme_eab {$ACME_EAB_KID} {$ACME_EAB_HMAC}
# which does not parse — Caddy rejects the whole config:
#     parsing caddyfile tokens for 'acme_eab': wrong argument count or unexpected
#     line ending after '<kid>'
# so an operator who enabled institutional ACME got an edge that REFUSED TO START, on the
# one code path where a broken edge takes every deployed app down with it.
acme_eab {
	key_id {$ACME_EAB_KID}
	mac_key {$ACME_EAB_HMAC}
}

# 🚨 DO NOT ADD A GLOBAL \`acme_dns\` BLOCK HERE. It is SILENTLY IGNORED — the config
# loads without complaint and certificates simply never issue by DNS. DNS-01 belongs in
# a site block or a \`tls\` directive. Requires an image built with
# \`xcaddy build --with github.com/caddy-dns/cloudflare\` (see ../Dockerfile.cloudflare).
`,
      "config/security/README.md": `# Caddy Security state

\`users.json\` is the authoritative local edge-identity store. Caddy Security creates it on
first start from the bootstrap environment and updates it through its identity flows.
AppBay-generated authorization policies live under \`policies/\` and are imported by the
base Caddyfile.

This directory is independent from AppBay control-plane users and from \`vault.enc\`.
`,
      "config/tls/README.md": `# Per-site TLS configuration

Files here are imported INTO every site block the ingress trait emits
(\`import /etc/caddy/tls/*.caddy\`), so they may contain only directives that are legal
inside a site block — a \`tls { … }\` directive, typically.

🚨 **DO NOT put DNS-01 config in a global \`acme_dns\` block instead.** Caddy SILENTLY
IGNORES it: the config loads without complaint and certificates simply never issue by DNS.
Per-site is the only form that works, which is why the import is per-site.

⚠️ \`appbay setup\` writes \`dns01-<provider>.caddy\` here when \`acme_dns_provider\` is set in
\`project.yaml\` (\`appbay init --acme-dns-provider cloudflare\`). A hand-written file is
honoured too, but appbay will overwrite the one it manages.

⚠️ The glob matches \`*.caddy\` only, so \`.md\` and \`.example\` files are inert.
`,
      "docker-compose.yml": `services:
  caddy:
    # Caddy mode means the integrated Caddy Security edge. There is intentionally no stock
    # Caddy fallback: silently losing authentication would be worse than refusing deploy.
    image: \${APPBAY_CADDY_IMAGE:-localhost/appbay-caddy-security:2.11.4-v1.1.64}
    # ⭐ HOISTED BY APPBAY, NOT RUN BY COMPOSE. This block stays here because it is where a
    # compose author would write it and it keeps this a valid compose file on its own — but
    # appbay's build stage builds it BEFORE deploy, pins \`image:\` to the tag in
    # appbay.yaml's \`builds:\`, and STRIPS this block from the rendered output. See
    # packages/core/src/compiler/builds.ts for why the render must not carry it.
    # The build is unconditional because Caddy Security is part of the supported edge mode;
    # Cloudflare remains available even when a particular installation does not use DNS-01.
    build:
      context: .
      dockerfile: config/Dockerfile.cloudflare
    # AppBay validates and explicitly reloads manifest-derived route/policy changes. Imported
    # files on bind mounts did not reliably trigger Caddy's watch path during rehearsal.
    command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
    container_name: appbay.caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - caddy-data:/data
      - caddy-config:/config
      - ./config/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./config/dynamic:/etc/caddy/dynamic:ro
      - ./config/global:/etc/caddy/global:ro
      # Caddy Security owns this store. The portal may update users.json, so this mount is
      # deliberately writable while Caddyfile and generated policy fragments stay read-only.
      - ./config/security:/etc/caddy/security
      # 🚨 WITHOUT THIS MOUNT THE PER-SITE TLS IMPORT CAN NEVER MATCH ANYTHING.
      # Every site block the ingress trait emits carries \`import /etc/caddy/tls/*.caddy\`,
      # and an import glob with ZERO matches is valid Caddy config — so the absence of this
      # directory produced no error at all. Measured 2026-08-07 in the running container:
      # \`/etc/caddy/tls: No such file or directory\`, while DNS-01 config had nowhere to live
      # and Caddy quietly issued from its INTERNAL CA instead. An install can look healthy
      # indefinitely having never spoken to a real CA.
      - ./config/tls:/etc/caddy/tls:ro
    # 🚨 PROVIDER-NEUTRAL ALIAS. Apps that must trust the reverse proxy (Nextcloud's
      # TRUSTED_PROXIES, Grafana's root_url checks, anything reading X-Forwarded-*) need a
      # name for it. Naming \`traefik\` or \`caddy\` directly breaks the moment the
      # installation selects the other one — and breaks SILENTLY: the app just decides the
      # forwarded headers are untrusted and serves wrong-scheme URLs.
      #
      # Both edges answer to \`appbay-edge\`, so an app names that and never learns which
      # proxy it is behind. This also keeps the per-app compose fragment byte-identical
      # across providers, which provider-agnostic.test.ts asserts.
    networks:
      appbay_shared:
        aliases:
          - appbay-edge
    environment:
      - TZ=\${TZ:-UTC}
      # 🚨 ACME/EAB values arrive as PROCESS ENV at deploy time and are never written to
      # the Caddyfile. \`docker compose config\` prints file contents in cleartext; it does
      # not print what the deploying process injected.
      - ACME_CA=\${ACME_CA:-}
      - ACME_EAB_KID=\${ACME_EAB_KID:-}
      - ACME_EAB_HMAC=\${ACME_EAB_HMAC:-}
      - ACME_EMAIL=\${ACME_EMAIL:-}
      - CLOUDFLARE_API_TOKEN=\${CLOUDFLARE_API_TOKEN:-}
      - APPBAY_EDGE_TOKEN_SECRET=\${APPBAY_EDGE_TOKEN_SECRET:?required}
      - AUTHP_ADMIN_USER=\${AUTHP_ADMIN_USER:-admin}
      - AUTHP_ADMIN_EMAIL=\${AUTHP_ADMIN_EMAIL:-admin@appbay.local}
      - AUTHP_ADMIN_SECRET=\${AUTHP_ADMIN_SECRET:?required}

volumes:
  caddy-data:
  caddy-config:

networks:
  appbay_shared:
    external: true
`,
    },
  },
  {
    name: "homeassistant",
    files: {
      "appbay.yaml": `project: default
environment: default
collection: [self-hosted, home-automation]
tags:
  tier: personal
  role: home-automation

upstream:
  source: ./docker-compose.yml
  expose:
    - homeassistant

traits:
  - type: ingress
    host: "ha.\${{project.DOMAIN}}"
    port: 8123
    service: homeassistant
    exposure: external
    tls:
      staging: false
  - type: hooks
    pattern: init
    image: busybox:latest
    command: "mkdir -p /config/custom_components && chown -R 1000:1000 /config"
    volumes:
      # The trait namespaces this to homeassistant_ha-config. Do NOT drop the mount
      # path to silence a compose error — a bare name is an ANONYMOUS volume, and the
      # hook then chowns its own ephemeral directory and exits 0.
      - ha-config:/config
  - type: backup
    schedule: "0 3 * * *"
    retention: 14
    volumes:
      - ha-config
`,
      "docker-compose.yml": `services:
  # MQTT broker — home automation device integration backbone
  mosquitto:
    image: docker.io/library/eclipse-mosquitto:latest
    container_name: appbay.homeassistant.mosquitto
    restart: unless-stopped
    volumes:
      - mosquitto-config:/mosquitto/config
      - mosquitto-data:/mosquitto/data
      - mosquitto-log:/mosquitto/log
    networks:
      - ha-internal

  # Zigbee2MQTT — bridges Zigbee devices to MQTT
  # Requires a Zigbee coordinator USB dongle; disable if not available.
  zigbee2mqtt:
    image: docker.io/koenkk/zigbee2mqtt:latest
    container_name: appbay.homeassistant.zigbee2mqtt
    restart: unless-stopped
    depends_on:
      - mosquitto
    volumes:
      - zigbee2mqtt-data:/app/data
      # Mount your Zigbee coordinator device; adjust path as needed
      # - /dev/ttyUSB0:/dev/ttyUSB0
    environment:
      TZ: \${TZ:-UTC}
      ZIGBEE2MQTT_CONFIG_MQTT_SERVER: mqtt://mosquitto
      ZIGBEE2MQTT_CONFIG_HOMEASSISTANT: "true"
    networks:
      - ha-internal

  homeassistant:
    image: ghcr.io/home-assistant/home-assistant:stable
    container_name: appbay.homeassistant
    restart: unless-stopped
    depends_on:
      - mosquitto
    volumes:
      - ha-config:/config
    environment:
      TZ: \${TZ:-UTC}
    ports:
      - "\${HA_PORT:-8123}:8123"
    # Home Assistant requires network_mode host for mDNS / device discovery,
    # OR configure the frontend.homeassistant section in HA's configuration.yaml.
    # Uncomment for full LAN device discovery:
    # network_mode: host
    networks:
      - ha-internal
      - appbay_shared

volumes:
  ha-config:
  mosquitto-config:
  mosquitto-data:
  mosquitto-log:
  zigbee2mqtt-data:

networks:
  ha-internal:
  appbay_shared:
    external: true
`,
    },
  },
  {
    name: "homepage",
    files: {
      "appbay.yaml": `project: system
environment: default
collection: [system, dashboard]
tags:
  tier: system
  role: dashboard

upstream:
  source: ./docker-compose.yml
  expose:
    - homepage

services:
  homepage:
    traits:
      - type: ingress
        host: \${APPBAY_DOMAIN:-appbay.local}
        port: 3000
        exposure: internal
`,
      "docker-compose.yml": `services:
  homepage:
    image: ghcr.io/gethomepage/homepage:latest
    container_name: appbay.homepage
    restart: unless-stopped
    environment:
      - PUID=1000
      - PGID=1000
      - HOMEPAGE_ALLOWED_HOSTS=*
    group_add:
      - "\${DOCKER_GID:-999}"
    ports:
      - "3001:3000"
    volumes:
      - homepage-config:/app/config
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - appbay_shared

volumes:
  homepage-config:

networks:
  appbay_shared:
    external: true
`,
    },
  },
  {
    name: "jellyfin",
    files: {
      "appbay.yaml": `project: default
environment: default
collection: [self-hosted, media]
tags:
  tier: personal
  role: media-server

upstream:
  source: ./docker-compose.yml
  expose:
    - jellyfin

traits:
  - type: ingress
    host: "jellyfin.\${{project.DOMAIN}}"
    port: 8096
    service: jellyfin
    exposure: external
    tls:
      staging: false
`,
      "docker-compose.yml": `services:
  jellyfin:
    image: docker.io/jellyfin/jellyfin:latest
    container_name: appbay.jellyfin
    restart: unless-stopped
    # Hardware transcoding: uncomment the device block matching your GPU
    # devices:
    #   - /dev/dri:/dev/dri          # Intel QSV / VAAPI
    #   - /dev/nvidia0:/dev/nvidia0  # NVIDIA (prefer the gpu trait instead)
    #   - /dev/nvidiactl:/dev/nvidiactl
    volumes:
      - jellyfin-config:/config
      - jellyfin-cache:/cache
      - \${JELLYFIN_MEDIA_PATH:-/mnt/media}:/media:ro
    environment:
      JELLYFIN_CACHE_DIR: \${JELLYFIN_CACHE_PATH:-/cache}
      JELLYFIN_PublishedServerUrl: https://jellyfin.\${{project.DOMAIN}}
    ports:
      - "8096:8096"
      # Optional: DLNA auto-discovery (LAN only)
      # - "1900:1900/udp"
      # - "7359:7359/udp"
    networks:
      - appbay_shared

volumes:
  jellyfin-config:
  jellyfin-cache:

networks:
  appbay_shared:
    external: true
`,
    },
  },
  {
    name: "keeweb",
    files: {
      "appbay.yaml": `project: default
environment: default
tags:
  tier: system
  role: secrets-ui

upstream:
  source: ./docker-compose.yml

services:
  keeweb:
    traits:
      - type: ingress
        host: secrets.\${APPBAY_DOMAIN:-appbay.local}
        port: 443
        exposure: internal
`,
      "docker-compose.yml": `services:
  keeweb:
    image: docker.io/antelle/keeweb:latest
    container_name: appbay.keeweb
    restart: unless-stopped
    ports:
      - "8443:443"
    volumes:
      - keeweb-data:/keeweb
      - \${APPBAY_HOME:-~/.appbay}/var/lib:/secrets:ro

volumes:
  keeweb-data:
    driver: local
`,
    },
  },
  {
    name: "nextcloud",
    files: {
      "appbay.yaml": `project: default
environment: default
collection: [self-hosted, productivity]
tags:
  tier: personal
  role: file-sync

upstream:
  source: ./docker-compose.yml
  expose:
    - nextcloud

traits:
  - type: ingress
    host: "cloud.\${{project.DOMAIN}}"
    port: 80
    service: nextcloud
    exposure: external
    tls:
      staging: false
  - type: backup
    schedule: "0 3 * * *"
    retention: 14
    volumes:
      - nextcloud-db
      - nextcloud-data
`,
      "docker-compose.yml": `services:
  db:
    image: docker.io/library/mariadb:11
    container_name: appbay.nextcloud.db
    restart: unless-stopped
    command: --transaction-isolation=READ-COMMITTED --log-bin=binlog --binlog-format=ROW
    volumes:
      - nextcloud-db:/var/lib/mysql
    environment:
      MARIADB_ROOT_PASSWORD: \${NEXTCLOUD_DB_PASSWORD:-changeme}
      MARIADB_DATABASE: nextcloud
      MARIADB_USER: nextcloud
      MARIADB_PASSWORD: \${NEXTCLOUD_DB_PASSWORD:-changeme}
    networks:
      - nextcloud-internal

  redis:
    image: docker.io/library/redis:7-alpine
    container_name: appbay.nextcloud.redis
    restart: unless-stopped
    command: >
      redis-server
      --requirepass \${NEXTCLOUD_REDIS_PASSWORD:-changeme}
      --save 60 1
      --loglevel warning
    volumes:
      - nextcloud-redis:/data
    networks:
      - nextcloud-internal

  nextcloud:
    image: docker.io/library/nextcloud:29-apache
    container_name: appbay.nextcloud
    restart: unless-stopped
    depends_on:
      - db
      - redis
    volumes:
      - nextcloud-data:/var/www/html
    environment:
      MYSQL_HOST: db
      MYSQL_DATABASE: nextcloud
      MYSQL_USER: nextcloud
      MYSQL_PASSWORD: \${NEXTCLOUD_DB_PASSWORD:-changeme}
      REDIS_HOST: redis
      REDIS_HOST_PASSWORD: \${NEXTCLOUD_REDIS_PASSWORD:-changeme}
      NEXTCLOUD_ADMIN_USER: \${NEXTCLOUD_ADMIN_USER:-admin}
      NEXTCLOUD_ADMIN_PASSWORD: \${NEXTCLOUD_ADMIN_PASSWORD:-changeme}
      NEXTCLOUD_TRUSTED_DOMAINS: \${NEXTCLOUD_DOMAIN:-cloud.localhost}
      # ⚠️ \`appbay-edge\` is the provider-neutral alias BOTH edges answer to. Naming
      # \`traefik\` here broke Caddy installs silently — nextcloud rejected the forwarded
      # headers and served wrong-scheme URLs rather than erroring.
      TRUSTED_PROXIES: \${NEXTCLOUD_TRUSTED_PROXIES:-appbay-edge}
      OVERWRITEPROTOCOL: https
      OVERWRITECLIURL: https://\${NEXTCLOUD_DOMAIN:-cloud.localhost}
    networks:
      - nextcloud-internal
      - appbay_shared

volumes:
  nextcloud-db:
  nextcloud-redis:
  nextcloud-data:

networks:
  nextcloud-internal:
  appbay_shared:
    external: true
`,
    },
  },
  {
    name: "ollama",
    files: {
      "appbay.yaml": `project: default
environment: default
collection: [ai-stack, gpu-apps]
tags:
  tier: compute
  role: llm-inference

upstream:
  source: ./docker-compose.yml
  expose:
    - ollama

traits:
  - type: gpu
    variant: nvidia
    service: ollama
    # Ollama runs on CPU — slowly, but usefully — so it opts OUT of the default
    # refuse-without-a-GPU behaviour. Most GPU apps should not.
    required: false
  - type: ingress
    host: "ollama.\${{project.DOMAIN}}"
    port: 11434
    service: ollama
    exposure: internal
`,
      "docker-compose.yml": `services:
  ollama:
    image: docker.io/ollama/ollama:latest
    container_name: appbay.ollama
    restart: unless-stopped
    ports:
      - "\${OLLAMA_PORT:-11434}:11434"
    volumes:
      - ollama-data:/root/.ollama
    environment:
      - OLLAMA_HOST=0.0.0.0
      - OLLAMA_KEEP_ALIVE=\${OLLAMA_KEEP_ALIVE:-24h}
    networks:
      - appbay_shared

volumes:
  ollama-data:

networks:
  appbay_shared:
    external: true
`,
    },
  },
  {
    name: "open-webui",
    files: {
      "appbay.yaml": `project: default
environment: default
collection: [ai-stack]
tags:
  tier: frontend
  role: chat-ui

upstream:
  source: ./docker-compose.yml
  expose:
    - open-webui

traits:
  - type: ingress
    host: "chat.\${{project.DOMAIN}}"
    port: 8080
    service: open-webui
    exposure: both
  - type: auth
    enabled: true
    mode: portal
    service: open-webui

# Conditional overlays — the killer feature
overlays:
  # When ollama is running, configure open-webui to use it via shared network
  - when: [ollama]
    services:
      open-webui:
        environment:
          - OLLAMA_BASE_URL=http://appbay.ollama:11434
          - ENABLE_OLLAMA_API=true

  # When whisper (TTS) is running, enable audio features
  - when: [whisper]
    services:
      open-webui:
        environment:
          - AUDIO_STT_ENGINE=openai
          - AUDIO_STT_OPENAI_API_BASE_URL=http://whisper_whisper:8000/v1

  # When both ollama AND searxng are available, enable web search
  - when: [ollama, searxng]
    services:
      open-webui:
        environment:
          - ENABLE_RAG_WEB_SEARCH=true
          - RAG_WEB_SEARCH_ENGINE=searxng
          - SEARXNG_QUERY_URL=http://searxng_searxng:8080/search?q=<query>
`,
      "docker-compose.yml": `services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    container_name: appbay.open-webui
    restart: unless-stopped
    ports:
      - "\${WEBUI_PORT:-3080}:8080"
    volumes:
      - open-webui-data:/app/backend/data
    environment:
      - WEBUI_NAME=\${WEBUI_NAME:-Appbay Chat}
      - OLLAMA_BASE_URL=\${OLLAMA_BASE_URL:-http://appbay.ollama:11434}
    networks:
      - appbay_shared

volumes:
  open-webui-data:

networks:
  appbay_shared:
    external: true
`,
    },
  },
  {
    name: "sysinfo",
    files: {
      "appbay.yaml": `project: default
environment: default
collection: [starter, diagnostics]
tags:
  tier: ops
  role: diagnostics

upstream:
  source: ./docker-compose.yml
  expose:
    - sysinfo

traits:
  - type: ingress
    host: "sysinfo.\${{project.DOMAIN}}"
    port: 8080
    service: sysinfo
    exposure: internal
`,
      "docker-compose.yml": `# Portable, read-only diagnostic endpoint for validating an Appbay data path.
# It deliberately has no runtime socket or host filesystem access.
services:
  sysinfo:
    image: docker.io/library/python:3.12-alpine
    container_name: appbay.sysinfo
    restart: unless-stopped
    environment:
      APPBAY_DIAGNOSTIC_SCOPE: container
    healthcheck:
      # CMD-SHELL remains a single command through Docker Compose's Podman API
      # compatibility path; CMD arrays are incorrectly split by that path.
      test:
        - CMD-SHELL
        - "python -c \\"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2)\\""
      interval: 10s
      timeout: 3s
      retries: 3
    command:
      - python
      - -c
      - |
        import html
        import http.server
        import json
        import os
        import platform
        import shutil
        import socket
        import time

        STARTED_AT = time.time()

        def snapshot(handler):
            memory = {}
            try:
                with open("/proc/meminfo", encoding="utf-8") as source:
                    for line in source:
                        key, _, value = line.partition(":")
                        if key in {"MemTotal", "MemAvailable"}:
                            memory[key] = value.strip()
            except OSError:
                pass
            disk = shutil.disk_usage("/")
            return {
                "service": "appbay-sysinfo",
                "status": "ok",
                "scope": os.getenv("APPBAY_DIAGNOSTIC_SCOPE", "container"),
                "hostname": socket.gethostname(),
                "platform": platform.platform(),
                "python": platform.python_version(),
                "process_uptime_seconds": round(time.time() - STARTED_AT, 1),
                "load_average": list(os.getloadavg()) if hasattr(os, "getloadavg") else None,
                "memory": memory,
                "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
                "request": {
                    "method": handler.command,
                    "path": handler.path,
                    "client": handler.client_address[0],
                    "headers": dict(handler.headers.items()),
                },
            }

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                info = snapshot(self)
                if self.path == "/healthz":
                    self.respond("application/json", b'{"status":"ok"}')
                    return
                if self.path == "/api/info":
                    self.respond("application/json", json.dumps(info, indent=2).encode())
                    return
                rows = "".join(
                    f"<tr><th>{html.escape(key)}</th><td><pre>{html.escape(json.dumps(value, indent=2))}</pre></td></tr>"
                    for key, value in info.items()
                )
                body = (
                    "<!doctype html><html><head><meta charset='utf-8'><title>Appbay Sysinfo</title>"
                    "<style>body{font:15px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem;color:#172033}"
                    "table{border-collapse:collapse;width:100%}th,td{border:1px solid #d8dee9;padding:.7rem;text-align:left;vertical-align:top}"
                    "th{width:13rem;background:#f3f5f8}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}</style>"
                    f"</head><body><h1>Appbay Sysinfo</h1><p>Portable container and request diagnostics.</p><table>{rows}</table></body></html>"
                ).encode()
                self.respond("text/html; charset=utf-8", body)

            def respond(self, content_type, body):
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):
                print(f"{self.client_address[0]} {format % args}", flush=True)

        http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
`,
    },
  },
  {
    name: "traefik",
    files: {
      "appbay.yaml": `project: system
environment: default
collection: [system, infrastructure]
tags:
  tier: system
  role: reverse-proxy

upstream:
  source: ./docker-compose.yml
  expose:
    - traefik
`,
      "config/dynamic/tls-options.yml": `tls:
  options:
    default:
      minVersion: VersionTLS12
      sniStrict: true
      cipherSuites:
        - TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
        - TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
        - TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
        - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
        - TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256
        - TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256
    modern:
      minVersion: VersionTLS13
      sniStrict: true
`,
      "config/traefik.yml": `api:
  dashboard: true
  insecure: true

entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
    http:
      tls:
        certResolver: letsencrypt

certificatesResolvers:
  letsencrypt:
    acme:
      email: \${ACME_EMAIL:-admin@example.com}
      storage: /letsencrypt/acme.json
      httpChallenge:
        entryPoint: web
  letsencrypt-staging:
    acme:
      email: \${ACME_EMAIL:-admin@example.com}
      storage: /letsencrypt/acme-staging.json
      caServer: https://acme-staging-v02.api.letsencrypt.org/directory
      httpChallenge:
        entryPoint: web

providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true
`,
      "docker-compose.yml": `services:
  traefik:
    image: docker.io/library/traefik:v3.4
    container_name: appbay.traefik
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "8080:8080"
    volumes:
      - traefik-certs:/letsencrypt
      - ./config/traefik.yml:/etc/traefik/traefik.yml:ro
      - ./config/dynamic:/etc/traefik/dynamic:ro
      - ./certs:/certs:ro
    # 🚨 PROVIDER-NEUTRAL ALIAS. Apps that must trust the reverse proxy (Nextcloud's
      # TRUSTED_PROXIES, Grafana's root_url checks, anything reading X-Forwarded-*) need a
      # name for it. Naming \`traefik\` or \`caddy\` directly breaks the moment the
      # installation selects the other one — and breaks SILENTLY: the app just decides the
      # forwarded headers are untrusted and serves wrong-scheme URLs.
      #
      # Both edges answer to \`appbay-edge\`, so an app names that and never learns which
      # proxy it is behind. This also keeps the per-app compose fragment byte-identical
      # across providers, which provider-agnostic.test.ts asserts.
    networks:
      appbay_shared:
        aliases:
          - appbay-edge
    environment:
      - TZ=\${TZ:-UTC}

volumes:
  traefik-certs:

networks:
  appbay_shared:
    external: true
`,
    },
  },
  {
    name: "vaultwarden",
    files: {
      "appbay.yaml": `project: default
environment: default
collection: [self-hosted, security]
tags:
  tier: personal
  role: password-manager

upstream:
  source: ./docker-compose.yml
  expose:
    - vaultwarden

traits:
  - type: ingress
    host: "vault.\${{project.DOMAIN}}"
    port: 80
    service: vaultwarden
    exposure: external
    tls:
      staging: false
  - type: backup
    schedule: "0 2 * * *"
    retention: 30
    volumes:
      - vaultwarden-data
`,
      "docker-compose.yml": `services:
  vaultwarden:
    image: docker.io/vaultwarden/server:latest
    container_name: appbay.vaultwarden
    restart: unless-stopped
    volumes:
      - vaultwarden-data:/data
    environment:
      # Public-facing URL — must match the ingress host exactly
      DOMAIN: \${VAULTWARDEN_DOMAIN:-https://vault.localhost}
      # Disable open registration by default — invite users manually
      SIGNUPS_ALLOWED: \${VAULTWARDEN_SIGNUPS_ALLOWED:-false}
      # Admin panel token — generate with: openssl rand -base64 48
      # Leave empty to disable the admin panel
      ADMIN_TOKEN: \${VAULTWARDEN_ADMIN_TOKEN:-}
      # Optional SMTP for email verification and invite emails
      SMTP_HOST: \${VAULTWARDEN_SMTP_HOST:-}
      SMTP_FROM: \${VAULTWARDEN_SMTP_FROM:-}
      SMTP_PORT: \${VAULTWARDEN_SMTP_PORT:-587}
      SMTP_SECURITY: starttls
      DATA_FOLDER: /data
    networks:
      - appbay_shared

volumes:
  vaultwarden-data:

networks:
  appbay_shared:
    external: true
`,
    },
  },
  {
    name: "whoami",
    files: {
      "appbay.yaml": `project: default
environment: default
collection: [starter]
tags:
  tier: demo
  role: health-check

upstream:
  source: ./docker-compose.yml
  expose:
    - whoami

traits:
  - type: ingress
    host: "whoami.\${{project.DOMAIN}}"
    port: 80
    service: whoami
    exposure: internal
`,
      "docker-compose.yml": `services:
  whoami:
    image: docker.io/traefik/whoami:latest
    container_name: appbay.whoami
    restart: unless-stopped
    ports:
      - "\${WHOAMI_PORT:-8888}:80"
    networks:
      - appbay_shared

networks:
  appbay_shared:
    external: true
`,
    },
  },
];
