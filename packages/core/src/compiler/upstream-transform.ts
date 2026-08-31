/**
 * Upstream transformer -- takes a stock upstream compose file and applies
 * namespace isolation so it can run alongside other apps safely.
 *
 * Key design principles (from agents.md / design.md):
 *   - No service rename: services keep their original names so that
 *     depends_on, links, and network_mode references all work unchanged.
 *   - Internal network per app preserves upstream service discovery.
 *   - Exposed services get aliases on shared network(s) for cross-app access.
 *   - Named volumes are prefixed to prevent collisions.
 *   - Relative bind mounts are rewritten relative to upstream source dir.
 *   - Excluded services are removed entirely.
 */

import type { ExposeEntry } from "../schemas/appbay-yaml.js";
import {
  containerName,
  sharedNetworkAlias,
  internalNetworkName,
  APP_LABEL,
  NAMESPACE_LABEL,
} from "./identity.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input to the upstream transform function. */
export interface UpstreamTransformInput {
  /** App name (directory name). */
  appName: string;
  /** Deployment namespace; `undefined` or "default" produces un-namespaced names. */
  namespace?: string;
  /** Parsed upstream docker-compose as a plain object. */
  compose: Record<string, unknown>;
  /** Upstream section from appbay.yaml. */
  upstream: {
    source?: string;
    services?: { exclude?: string[] };
    expose?: ExposeEntry[];
  };
  /** Shared networks this app should be connected to (e.g., ["appbay_shared"]). */
  sharedNetworks: string[];
  /** Base path for the apps directory (used for relative path resolution). */
  appsDir: string;
  /**
   * Relative path from the rendered compose directory to the apps directory.
   * Computed as `path.relative(join(rendersDir, appName), appsDir)`.
   * Example: "../../../../etc/apps"
   * When omitted, falls back to the legacy "apps" segment.
   */
  appsRelPath?: string;
}

/** Output from the upstream transform function. */
export interface UpstreamTransformOutput {
  /** Transformed compose document. */
  compose: Record<string, unknown>;
  /** Name of the internal network created for this app. */
  internalNetwork: string;
  /** Map of service name to aliases assigned on shared networks. */
  exposedAliases: Map<string, string[]>;
}

// ---------------------------------------------------------------------------
// Volume entry types (compose short and long syntax)
// ---------------------------------------------------------------------------

interface VolumeLongSyntax {
  type?: string;
  source?: string;
  target?: string;
  [key: string]: unknown;
}

type VolumeEntry = string | VolumeLongSyntax;

// ---------------------------------------------------------------------------
// Compose service definition (subset of fields we inspect/mutate)
// ---------------------------------------------------------------------------

interface ServiceDef {
  container_name?: string;
  networks?: string[] | Record<string, unknown>;
  network_mode?: string;
  volumes?: VolumeEntry[];
  env_file?: string | Array<string | { path: string; required?: boolean }>;
  depends_on?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

/**
 * Transform an upstream compose file for namespace isolation.
 *
 * This is a pure function -- it does not read or write the filesystem.
 */
export function transformUpstream(
  input: UpstreamTransformInput,
): UpstreamTransformOutput {
  const { appName, namespace, compose, upstream, sharedNetworks, appsDir, appsRelPath } =
    input;

  const internalNetwork = internalNetworkName(namespace, appName);
  const exclude = new Set(upstream.services?.exclude ?? []);

  // Build expose lookup: service name -> list of networks it should join
  // Expose entries can be: string, { svc: alias } map, or { service, networks? } object
  const exposeMap = new Map<string, string[]>();
  for (const entry of upstream.expose ?? []) {
    if (typeof entry === "string") {
      exposeMap.set(entry, sharedNetworks);
    } else if (
      typeof entry === "object" &&
      entry !== null &&
      "service" in entry &&
      typeof (entry as Record<string, unknown>).service === "string"
    ) {
      const full = entry as { service: string; networks?: string[] };
      exposeMap.set(full.service, full.networks ?? sharedNetworks);
    } else if (typeof entry === "object" && entry !== null) {
      // Record<string, string> alias map — key is service name
      for (const svc of Object.keys(entry)) {
        exposeMap.set(svc, sharedNetworks);
      }
    }
  }

  // Gather original network names (used as aliases on the internal network)
  const originalNetworks = new Set<string>();
  const composeNetworks = (compose.networks ?? {}) as Record<string, unknown>;
  for (const netName of Object.keys(composeNetworks)) {
    originalNetworks.add(netName);
  }

  // Track original named volumes for prefixing in service volume mounts
  const originalVolumes = new Set<string>();
  const composeVolumes = (compose.volumes ?? {}) as Record<string, unknown>;
  for (const volName of Object.keys(composeVolumes)) {
    originalVolumes.add(volName);
  }

  // ---------------------------------------------------------------------------
  // Transform services
  // ---------------------------------------------------------------------------

  const services = (compose.services ?? {}) as Record<string, ServiceDef>;
  const transformedServices: Record<string, ServiceDef> = {};
  const exposedAliases = new Map<string, string[]>();

  for (const [name, service] of Object.entries(services)) {
    // Skip excluded services
    if (exclude.has(name)) {
      continue;
    }

    const svc: ServiceDef = { ...service };

    // Container name: appbay.<appname>.<service>, namespaced when there is one.
    svc.container_name = containerName(namespace, appName, name);

    // Labels so consumers can ask which app/namespace a container belongs to instead of
    // parsing its name — see identity.ts APP_LABEL for why parsing does not survive §4.
    svc.labels = {
      ...(typeof svc.labels === "object" && !Array.isArray(svc.labels) ? svc.labels : {}),
      [APP_LABEL]: appName,
      [NAMESPACE_LABEL]: namespace ?? "default",
    };

    // Network configuration (skip if service uses network_mode)
    if (!svc.network_mode) {
      const networks: Record<string, unknown> = {};

      // All services join the internal network with original network names as aliases
      // so upstream service discovery continues to work
      const internalAliases = [name];
      networks[internalNetwork] = { aliases: internalAliases };

      // If this service is exposed, add it to the specified shared networks
      const exposeNetworks = exposeMap.get(name);
      if (exposeNetworks) {
        const alias = sharedNetworkAlias(namespace, appName, name);
        const aliases: string[] = [alias];
        exposedAliases.set(name, aliases);

        for (const netName of exposeNetworks) {
          // 🚨 PRESERVE AUTHOR-DECLARED ALIASES. This used to assign
          // `{ aliases: [generated] }`, replacing the whole network entry — so an alias
          // written in the upstream compose was silently discarded. Nothing errored; the
          // name simply never resolved, which surfaces as a connection failure in an
          // unrelated app much later.
          //
          // Found via the `appbay-edge` alias both proxies declare so that apps can name
          // the edge without naming the provider: it was dropped here and
          // `nslookup appbay-edge` returned NXDOMAIN.
          // ⚠️ Read from the ORIGINAL service, not from `networks` — that object is built
          // fresh above and is always empty here, so checking it would silently preserve
          // nothing while looking like it did.
          const authored = (service as ServiceDef).networks;
          const authoredEntry =
            authored && !Array.isArray(authored) && typeof authored === "object"
              ? (authored as Record<string, unknown>)[netName]
              : undefined;
          const declared =
            authoredEntry &&
            typeof authoredEntry === "object" &&
            Array.isArray((authoredEntry as { aliases?: unknown }).aliases)
              ? ((authoredEntry as { aliases: unknown[] }).aliases.filter(
                  (a): a is string => typeof a === "string",
                ))
              : [];
          networks[netName] = { aliases: [...new Set([...aliases, ...declared])] };
        }
      }

      svc.networks = networks;
    }

    // Transform volumes: prefix named volumes, rewrite relative bind mounts
    if (svc.volumes) {
      svc.volumes = transformVolumes(
        svc.volumes,
        appName,
        originalVolumes,
        appsDir,
        upstream.source,
        appsRelPath,
      );
    }

    // Inject app-level .env + .env.local via env_file (absolute paths so they work from renders dir)
    // Precedence: later entries override earlier ones, so .env.local overrides .env
    // .env.local is optional (only exists for catalog-installed apps with config overrides)
    const appEnvPath = { path: `${appsDir}/${appName}/.env`, required: false };
    const appEnvLocal = { path: `${appsDir}/${appName}/.env.local`, required: false };
    const existingEnvFiles = Array.isArray(svc.env_file)
      ? svc.env_file
      : typeof svc.env_file === "string"
        ? [svc.env_file]
        : [];
    svc.env_file = [appEnvPath, appEnvLocal, ...existingEnvFiles];

    // Strip depends_on entries that reference excluded services
    if (svc.depends_on && exclude.size > 0) {
      if (typeof svc.depends_on === "object" && !Array.isArray(svc.depends_on)) {
        const filtered: Record<string, unknown> = {};
        for (const [dep, config] of Object.entries(svc.depends_on as Record<string, unknown>)) {
          if (!exclude.has(dep)) filtered[dep] = config;
        }
        svc.depends_on = Object.keys(filtered).length > 0 ? filtered : undefined;
      } else if (Array.isArray(svc.depends_on)) {
        const filtered = (svc.depends_on as string[]).filter((d) => !exclude.has(d));
        svc.depends_on = filtered.length > 0 ? filtered : undefined;
      }
    }

    transformedServices[name] = svc;
  }

  // ---------------------------------------------------------------------------
  // Transform top-level volumes (prefix names)
  // ---------------------------------------------------------------------------

  const transformedVolumes: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(composeVolumes)) {
    transformedVolumes[`${appName}_${name}`] = config;
  }

  // ---------------------------------------------------------------------------
  // Build top-level networks
  // ---------------------------------------------------------------------------

  const transformedNetworks: Record<string, unknown> = {
    [internalNetwork]: {
      name: internalNetworkName(namespace, appName),
    },
  };

  // Add shared networks as external
  for (const netName of sharedNetworks) {
    transformedNetworks[netName] = { external: true };
  }

  // Also add any expose-specific networks that are not in sharedNetworks
  for (const entry of upstream.expose ?? []) {
    const nets =
      typeof entry === "string"
        ? sharedNetworks
        : "service" in entry && typeof entry.service === "string"
          ? (entry.networks ?? sharedNetworks)
          : sharedNetworks;
    for (const netName of nets) {
      if (!transformedNetworks[netName]) {
        transformedNetworks[netName] = { external: true };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Assemble output compose
  // ---------------------------------------------------------------------------

  const outputCompose: Record<string, unknown> = {
    services: transformedServices,
    networks: transformedNetworks,
    volumes: transformedVolumes,
  };

  // Preserve x- extension fields from the original compose
  for (const [key, value] of Object.entries(compose)) {
    if (key.startsWith("x-")) {
      outputCompose[key] = value;
    }
  }

  return {
    compose: outputCompose,
    internalNetwork,
    exposedAliases,
  };
}

// ---------------------------------------------------------------------------
// Volume transformation helpers
// ---------------------------------------------------------------------------

/**
 * Transform volume entries: prefix named volumes, rewrite relative bind mounts.
 */
function transformVolumes(
  volumes: VolumeEntry[],
  appName: string,
  originalVolumes: Set<string>,
  appsDir: string,
  upstreamSource?: string,
  appsRelPath?: string,
): VolumeEntry[] {
  return volumes.map((vol) => {
    // Long syntax (object)
    if (typeof vol === "object" && vol !== null) {
      const transformed = { ...vol };
      if (transformed.type === "volume" && transformed.source) {
        if (originalVolumes.has(transformed.source)) {
          transformed.source = `${appName}_${transformed.source}`;
        }
      }
      // Rewrite relative bind mount source in long syntax
      if (transformed.type === "bind" && transformed.source?.startsWith("./")) {
        transformed.source = rewriteRelativePath(
          transformed.source,
          appName,
          appsDir,
          upstreamSource,
          appsRelPath,
        );
      }
      return transformed;
    }

    // Short syntax (string): "source:target" or "source:target:mode"
    const parts = vol.split(":");
    if (parts.length >= 2) {
      const source = parts[0];

      // Named volume (not starting with . or /)
      if (!source.startsWith(".") && !source.startsWith("/")) {
        if (originalVolumes.has(source)) {
          parts[0] = `${appName}_${source}`;
          return parts.join(":");
        }
        return vol;
      }

      // Relative bind mount
      if (source.startsWith("./")) {
        parts[0] = rewriteRelativePath(source, appName, appsDir, upstreamSource, appsRelPath);
      }

      // 🚨 EVERY BIND MOUNT NEEDS AN SELINUX LABEL OPTION OR IT IS UNREADABLE ON RHEL.
      // Without `:z` the container process (container_t) cannot read a source labelled
      // user_home_t, and the failure is a bare EACCES with no mention of SELinux.
      // Measured on Fedora 43, SELinux Enforcing — the Caddy edge crash-looped 62 times on:
      //     Error: reading config from file: open /etc/caddy/Caddyfile: permission denied
      // and the deploy reported "Caddy configuration rejected", sending the operator to
      // inspect a Caddyfile that was perfectly valid. Proven minimal:
      //     podman run -v <file>:/x:ro     -> Permission denied
      //     podman run -v <file>:/x:ro,z   -> file contents
      //
      // ⚠️ Applied UNCONDITIONALLY, not behind a runtime check. Docker accepts and ignores
      // the option when SELinux is not enforcing, so one code path stays correct on both —
      // which is S23's rule (no `if (runtime === "podman")`). Adding it only for Podman
      // would also silently break the day a Docker host runs SELinux.
      //
      // `z` (shared) not `Z` (private): several containers legitimately read the same
      // config tree — the edge and the shepherd that materialises secrets, for instance.
      // `Z` would relabel it exclusively to one container and break the others.
      return appendSelinuxLabel(parts);
    }

    return vol;
  });
}

/**
 * Append the shared SELinux relabel option to a short-syntax bind mount.
 *
 * Idempotent: a mount that already carries `z` or `Z` is returned untouched, so an author
 * who has thought about labelling keeps their choice.
 */
function appendSelinuxLabel(parts: string[]): string {
  if (parts.length === 2) return `${parts.join(":")}:z`;
  const options = parts[2].split(",").map((o) => o.trim()).filter(Boolean);
  if (options.includes("z") || options.includes("Z")) return parts.join(":");
  options.push("z");
  return `${parts[0]}:${parts[1]}:${options.join(",")}`;
}

/**
 * Rewrite a relative path so it is valid relative to the rendered compose directory.
 *
 * Rendered compose files live at `<rendersDir>/<appName>/docker-compose.rendered.yml`.
 * Docker Compose resolves relative volume paths from that directory, so we must
 * express the path relative to it rather than relative to APPBAY_HOME.
 *
 * Example: `./config/traefik.yml` with app "traefik",
 *   appsRelPath "../../etc/apps", and no upstreamDir
 *   → `../../etc/apps/traefik/config/traefik.yml`
 *
 * @param appsRelPath - Relative path from `<rendersDir>/<appName>/` to appsDir.
 *   Computed as `path.relative(join(rendersDir, appName), appsDir)`.
 *   Falls back to `apps` (legacy flat layout) when not provided.
 */
export function rewriteRelativePath(
  relativePath: string,
  appName: string,
  _appsDir: string,
  upstreamSource?: string,
  appsRelPath?: string,
): string {
  // Strip leading "./"
  const pathWithinUpstream = relativePath.slice(2);

  // Derive upstream directory from source path (strip filename)
  let upstreamDir = "";
  if (upstreamSource) {
    const lastSlash = upstreamSource.lastIndexOf("/");
    if (lastSlash >= 0) {
      upstreamDir = upstreamSource.slice(0, lastSlash);
    }
    // If source has no slash (e.g., "docker-compose.yml"), upstream dir is the app root
  }

  // Use the computed relative prefix (e.g. "../../etc/apps") when available,
  // otherwise fall back to the legacy "apps" segment for backwards compatibility.
  const prefix = appsRelPath ?? "apps";

  if (upstreamDir) {
    return `./${prefix}/${appName}/${upstreamDir}/${pathWithinUpstream}`;
  }
  return `./${prefix}/${appName}/${pathWithinUpstream}`;
}
