/**
 * Ingress trait definition.
 *
 * Generates Traefik dynamic config YAML (file provider, NOT Docker labels)
 * for service exposure. Supports internal (LAN), external (WAN), or both
 * exposure modes with staging/production TLS cert resolvers.
 *
 * Output:
 *   - Compose fragment: attaches the target service to `appbay_shared` so
 *     Traefik can route to it.
 *   - Auxiliary file: `traefik/dynamic/<appName>.yml` containing router,
 *     service, and middleware definitions for the Traefik file provider.
 *
 * Scope: service-level.
 */

import { stringify as yamlStringify } from "yaml";
import { IngressTraitSchema } from "../../schemas/appbay-yaml.js";
import type { IngressTrait } from "../../schemas/appbay-yaml.js";
import type {
  TraitDefinition,
  TraitTransformInput,
  TraitTransformOutput,
} from "../types.js";
import { sharedNetworkAlias, auxFileStem } from "../../compiler/identity.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a unique router name from app name and optional service name.
 * Traefik router names must be alphanumeric + hyphens.
 */
export function routerName(app: string, service?: string): string {
  const base = service ? `${app}-${service}` : app;
  return base.replace(/[^a-zA-Z0-9-]/g, "-");
}

/**
 * Select the appropriate cert resolver based on TLS config.
 * Staging uses the Let's Encrypt staging CA (for testing).
 */
export function certResolverName(tls?: IngressTrait["tls"]): string {
  return tls?.staging ? "letsencrypt-staging" : "letsencrypt";
}

/**
 * Build the Traefik dynamic config object for the given ingress properties.
 *
 * Router and service names follow the pattern `<appName>-router`,
 * `<appName>-service`, etc. Service URL uses the shared-network alias
 * format `<appName>_<serviceName>:<port>`.
 *
 * Exposure modes:
 *   - "external": HTTPS only via `websecure` entrypoint.
 *   - "internal": HTTPS only via `websecure` (LAN restriction is handled
 *     by firewall/DNS, not Traefik itself).
 *   - "both": `web` (HTTP) and `websecure` (HTTPS) entrypoints.
 *
 * A secure-headers middleware is attached to every router for baseline
 * security (HSTS, content-type sniffing, XSS filter, referrer policy).
 */
export function buildTraefikConfig(
  appName: string,
  serviceName: string,
  props: IngressTrait,
  namespace?: string,
): Record<string, unknown> {
  const { host, port, exposure, tls } = props;
  const resolver = certResolverName(tls);
  // Must match the alias upstream-transform publishes, byte for byte — identity.ts owns
  // that format so this cannot drift from it.
  const serviceUrl = `http://${sharedNetworkAlias(namespace, appName, serviceName)}:${port}`;
  const name = routerName(appName, serviceName);
  const middlewareName = `${name}-secure-headers`;

  const routers: Record<string, unknown> = {};

  // Local TLDs (.local, .lan, .internal, .test, .localhost) use a self-signed
  // wildcard cert (no ACME). Public domains use Let's Encrypt.
  // All domains route through websecure; the authentication portal requires HTTPS.
  const isLocalDomain = /\.(local|lan|internal|test|localhost)$/i.test(host);

  if (exposure === "external" || exposure === "both" || exposure === "internal") {
    const routerConfig: Record<string, unknown> = {
      rule: `Host(\`${host}\`)`,
      service: `${name}-service`,
      entryPoints: ["websecure"],
      middlewares: [middlewareName],
    };
    if (isLocalDomain) {
      routerConfig.tls = {};
    } else {
      routerConfig.tls = { certResolver: resolver };
    }
    routers[`${name}-router`] = routerConfig;
  }

  // HTTP → HTTPS redirect for public domains
  if (exposure === "both" && !isLocalDomain) {
    routers[`${name}-http-redirect`] = {
      rule: `Host(\`${host}\`)`,
      service: `${name}-service`,
      entryPoints: ["web"],
      middlewares: [middlewareName],
    };
  }

  return {
    http: {
      routers,
      services: {
        [`${name}-service`]: {
          loadBalancer: {
            servers: [{ url: serviceUrl }],
          },
        },
      },
      middlewares: {
        [middlewareName]: {
          headers: {
            stsSeconds: 63072000,
            stsIncludeSubdomains: true,
            stsPreload: true,
            forceSTSHeader: true,
            contentTypeNosniff: true,
            browserXssFilter: true,
            referrerPolicy: "same-origin",
            customResponseHeaders: {
              "X-Robots-Tag":
                "none,noindex,nofollow,noarchive,nosnippet,notranslate,noimageindex",
              server: "",
            },
          },
        },
      },
    },
  };
}

/**
 * Compute the auxiliary file path for the Traefik dynamic config.
 *
 * Path is relative to APPBAY_HOME and matches the volume mount in the
 * traefik system app: `etc/apps/traefik/config/dynamic/`.
 * The CLI writes aux files anchored to APPBAY_HOME so they land where
 * Traefik's file provider watches.
 */
export function traefikAuxPath(appName: string, namespace?: string): string {
  return `etc/apps/traefik/config/dynamic/${auxFileStem(namespace, appName)}.yml`;
}

// ---------------------------------------------------------------------------
// Caddy emitter
// ---------------------------------------------------------------------------

/**
 * Auxiliary file path for an app's Caddy site block.
 *
 * Mirrors traefikAuxPath: relative to APPBAY_HOME, landing where the caddy system app's
 * Caddyfile imports from (`import config/dynamic/*.caddy`).
 */
export function caddyAuxPath(appName: string, namespace?: string): string {
  return `etc/apps/caddy/config/dynamic/${auxFileStem(namespace, appName)}.caddy`;
}

/**
 * Build an app's Caddy site block.
 *
 * ⭐ CADDY COMPOSES ACROSS FILES THE SAME WAY TRAEFIK DOES — verified, not assumed.
 * Traefik composes by NAME (the auth trait defines a middleware, this router references
 * it, the file provider resolves it). Caddy composes by FILE GLOB: this block imports
 * `auth/<app>-*.caddy`, and the auth trait drops its `forward_auth` fragment there.
 *
 * The property that makes it work, tested against caddy 2-alpine:
 *
 *     import auth/grafana-*.caddy      with ZERO matching files  -> "Valid configuration"
 *
 * ⚠️ That is true of the GLOB form only. `import <snippet-name>` on an undefined snippet
 * IS a hard error, and conflating the two is what nearly turned this into a redesign.
 *
 * ⚠️ Two files declaring the same site address is `ambiguous site definition` — also
 * tested — so exactly one emitter may own the block. That is this one: it knows the host,
 * the upstream and the port.
 *
 * Ordering is semantic: forward_auth must precede reverse_proxy or the proxy is not
 * gated. The import sits above reverse_proxy for that reason. Verified in the adapted
 * JSON—the authorization handler must precede the upstream reverse proxy.
 */
export function buildCaddySnippet(
  appName: string,
  serviceName: string,
  props: IngressTrait,
  namespace?: string,
): string {
  // Upstream transform exposes services on appbay_shared as <app>_<service>. Caddy is not
  // attached to the app's private network, so the bare Compose service name cannot resolve
  // from the edge container even though it resolves between services inside the app.
  const upstream = `${sharedNetworkAlias(namespace, appName, serviceName)}:${String(props.port)}`;
  return [
    "# Generated by Appbay — do not edit manually",
    `${props.host} {`,
    "\timport appbay_security_headers",
    // 🚨 TLS CONFIG MUST BE PER-SITE, NOT GLOBAL. A global `acme_dns` block is SILENTLY
    // IGNORED by Caddy — certificates never issue and the log looks the same either way.
    // So the DNS-01 challenge config is imported INTO each site block. Zero-match glob, so
    // an install using the internal issuer needs no file and no placeholder.
    "\timport /etc/caddy/tls/*.caddy",
    "\troute {",
    `\t\timport auth/${appName}-*.caddy`,
    `\t\treverse_proxy ${upstream}`,
    "\t}",
    "}",
    "",
  ].join("\n");
}

/**
 * Ensure the target service is attached to the `appbay_shared` network
 * so Traefik can route to it via the shared Docker network.
 */
function attachToSharedNetwork(
  compose: Record<string, unknown>,
  appName: string,
  service: string | undefined,
): Record<string, unknown> {
  if (!service) {
    return compose;
  }

  const result = { ...compose };
  const services = { ...((result.services ?? {}) as Record<string, unknown>) };
  const svc = { ...((services[service] as Record<string, unknown>) ?? {}) };

  const alias = `${appName}_${service}`;
  const serviceNetworks: Record<string, unknown> = Array.isArray(svc.networks)
    ? Object.fromEntries(svc.networks.map((network) => [String(network), {}]))
    : typeof svc.networks === "object" && svc.networks !== null
      ? { ...(svc.networks as Record<string, unknown>) }
      : {};
  const shared = typeof serviceNetworks.appbay_shared === "object" && serviceNetworks.appbay_shared !== null
    ? { ...(serviceNetworks.appbay_shared as Record<string, unknown>) }
    : {};
  const aliases = Array.isArray(shared.aliases) ? shared.aliases.map(String) : [];
  shared.aliases = [...new Set([...aliases, alias])];
  serviceNetworks.appbay_shared = shared;
  svc.networks = serviceNetworks;

  services[service] = svc;
  result.services = services;
  const networks = { ...((result.networks ?? {}) as Record<string, unknown>) };
  networks.appbay_shared = {
    ...((networks.appbay_shared ?? {}) as Record<string, unknown>),
    external: true,
  };
  result.networks = networks;
  return result;
}

/**
 * Remove host port mappings that publish the ingress port.
 * Traefik routes via the shared network, so direct host→container port
 * mappings are unnecessary and cause conflicts (multiple apps on 8080, etc.).
 */
function stripIngressPort(
  compose: Record<string, unknown>,
  service: string,
  ingressPort: number,
): Record<string, unknown> {
  const result = { ...compose };
  const services = { ...((result.services ?? {}) as Record<string, unknown>) };
  const svc = { ...((services[service] as Record<string, unknown>) ?? {}) };

  if (Array.isArray(svc.ports)) {
    const containerPortStr = String(ingressPort);
    svc.ports = (svc.ports as unknown[]).filter((entry) => {
      const s = String(entry);
      // Match patterns like "8080:8080", "${PORT:-8080}:8080", "3000:8080"
      const colonIdx = s.lastIndexOf(":");
      if (colonIdx < 0) return true;
      const containerPart = s.substring(colonIdx + 1).replace(/\/\w+$/, ""); // strip /tcp /udp
      return containerPart !== containerPortStr;
    });
    if ((svc.ports as unknown[]).length === 0) {
      delete svc.ports;
    }
  }

  services[service] = svc;
  result.services = services;
  return result;
}

// ---------------------------------------------------------------------------
// Trait Definition
// ---------------------------------------------------------------------------


export const ingressTraitDefinition: TraitDefinition<"ingress"> = {
  type: "ingress",
  category: "core",
  scope: "service",
  conflictsWith: [],
  description:
    "Traefik dynamic config YAML generation (file provider). Per-service " +
    "exposure: internal (LAN), external (WAN), or both. TLS " +
    "staging/production cert resolvers. Attaches service to appbay_shared " +
    "network.",
  schema: IngressTraitSchema,
  transform(input: TraitTransformInput): TraitTransformOutput {
    const props = input.properties as IngressTrait;
    const appName = input.app;
    const serviceName = input.service ?? appName;

    // Attach the target service to the shared network for Traefik routing.
    let compose = attachToSharedNetwork(input.compose, appName, input.service);

    // Strip host port mappings for the ingress port — Traefik handles routing
    // via the shared network, so publishing host ports causes conflicts when
    // multiple apps share the same default port (e.g., 8080, 3000).
    if (input.service) {
      compose = stripIngressPort(compose, input.service, props.port);
    }

    // ⚠️ THE ONLY PLACE THE INGRESS PROVIDER IS BRANCHED ON. Everything above — the
    // shared-network attachment and the port stripping — is provider-independent and
    // must stay that way. A second divergence belongs in this table, not threaded
    // through the trait as another conditional.
    const provider = input.context.ingressProvider ?? "traefik";
    const namespace = input.context.namespace;

    const { path, content } =
      provider === "caddy"
        ? {
            path: caddyAuxPath(appName, namespace),
            content: buildCaddySnippet(appName, serviceName, props, namespace),
          }
        : {
            path: traefikAuxPath(appName, namespace),
            content: yamlStringify(
              buildTraefikConfig(appName, serviceName, props, namespace),
              { sortMapEntries: true },
            ),
          };

    return {
      compose,
      auxiliaryFiles: [{ path, content }],
      // The trait declares the route; the deploy service owns activation. It installs all
      // route/policy fragments, validates the complete imported Caddyfile, then reloads Caddy
      // without a restart. That keeps manifest compilation separate from consumer lifecycle.
    };
  },
};
