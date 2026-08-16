import { describe, it, expect } from "vitest";
import {
  transformUpstream,
  rewriteRelativePath,
  type UpstreamTransformInput,
} from "../upstream-transform.js";
import type { ExposeEntry } from "../../schemas/appbay-yaml.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal UpstreamTransformInput with sensible defaults. */
function makeInput(
  overrides: Partial<UpstreamTransformInput> = {},
): UpstreamTransformInput {
  return {
    appName: "jellyfin",
    compose: {
      services: {
        app: { image: "jellyfin/jellyfin:latest" },
      },
    },
    upstream: { source: "jellyfin-upstream/docker-compose.yml" },
    sharedNetworks: ["appbay_shared"],
    appsDir: "/opt/appbay/etc/apps",
    ...overrides,
  };
}

/** Shorthand to access services from transformed output. */
function getServices(
  compose: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  return compose.services as Record<string, Record<string, unknown>>;
}

/** Shorthand to access networks from transformed output. */
function getNetworks(
  compose: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  return compose.networks as Record<string, Record<string, unknown>>;
}

/** Shorthand to access volumes from transformed output. */
function getVolumes(
  compose: Record<string, unknown>,
): Record<string, unknown> {
  return compose.volumes as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Services keep original names (no rename)
// ---------------------------------------------------------------------------

describe("transformUpstream", () => {
  it("keeps original service names unchanged", () => {
    const input = makeInput({
      compose: {
        services: {
          web: { image: "nginx" },
          redis: { image: "redis:7" },
          postgres: { image: "postgres:16" },
        },
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);

    expect(Object.keys(services)).toEqual(
      expect.arrayContaining(["web", "redis", "postgres"]),
    );
    expect(Object.keys(services)).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // 2. Container names are set to appbay.<appname>.<service>
  // ---------------------------------------------------------------------------

  it("sets container names to appbay.<appname>.<service>", () => {
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          web: { image: "nginx" },
          db: { image: "postgres:16" },
        },
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);

    expect(services.web.container_name).toBe("appbay.myapp.web");
    expect(services.db.container_name).toBe("appbay.myapp.db");
  });

  // ---------------------------------------------------------------------------
  // 3. Internal network created with original name aliases
  // ---------------------------------------------------------------------------

  it("creates internal network and assigns service name aliases", () => {
    const input = makeInput({
      appName: "jellyfin",
      compose: {
        services: {
          app: { image: "jellyfin/jellyfin" },
          redis: { image: "redis:7" },
        },
      },
    });

    const result = transformUpstream(input);

    // Internal network is named <appname>_internal
    expect(result.internalNetwork).toBe("jellyfin_internal");

    const networks = getNetworks(result.compose);
    expect(networks.jellyfin_internal).toEqual({
      name: "jellyfin_internal",
    });

    // Each service should have the internal network with its name as alias
    const services = getServices(result.compose);
    const appNetworks = services.app.networks as Record<string, unknown>;
    expect(appNetworks.jellyfin_internal).toEqual({
      aliases: ["app"],
    });

    const redisNetworks = services.redis.networks as Record<string, unknown>;
    expect(redisNetworks.jellyfin_internal).toEqual({
      aliases: ["redis"],
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Exposed services get aliases on shared network
  // ---------------------------------------------------------------------------

  it("adds aliases on shared networks for exposed services", () => {
    const input = makeInput({
      appName: "jellyfin",
      compose: {
        services: {
          app: { image: "jellyfin/jellyfin" },
          redis: { image: "redis:7" },
        },
      },
      upstream: {
        source: "jellyfin-upstream/docker-compose.yml",
        expose: [
          { service: "app", networks: ["appbay_shared"] },
          { service: "redis", networks: ["appbay_shared", "proxy"] },
        ],
      },
      sharedNetworks: ["appbay_shared"],
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);

    // app should have alias on appbay_shared
    const appNetworks = services.app.networks as Record<
      string,
      { aliases: string[] }
    >;
    expect(appNetworks.appbay_shared.aliases).toContain("jellyfin_app");

    // redis should have alias on both appbay_shared and proxy
    const redisNetworks = services.redis.networks as Record<
      string,
      { aliases: string[] }
    >;
    expect(redisNetworks.appbay_shared.aliases).toContain("jellyfin_redis");
    expect(redisNetworks.proxy.aliases).toContain("jellyfin_redis");

    // exposedAliases map should reflect these
    expect(result.exposedAliases.get("app")).toEqual(["jellyfin_app"]);
    expect(result.exposedAliases.get("redis")).toEqual(["jellyfin_redis"]);

    // Shared and expose-specific networks appear in top-level networks
    const networks = getNetworks(result.compose);
    expect(networks.appbay_shared).toEqual({ external: true });
    expect(networks.proxy).toEqual({ external: true });
  });

  // ---------------------------------------------------------------------------
  // 5. Named volumes are prefixed with <appname>_
  // ---------------------------------------------------------------------------

  it("prefixes named volumes with app name", () => {
    const input = makeInput({
      appName: "jellyfin",
      compose: {
        services: {
          app: {
            image: "jellyfin/jellyfin",
            volumes: ["media_data:/media", "config:/config"],
          },
        },
        volumes: {
          media_data: {},
          config: { driver: "local" },
        },
      },
    });

    const result = transformUpstream(input);

    // Top-level volumes should be prefixed
    const volumes = getVolumes(result.compose);
    expect(volumes).toHaveProperty("jellyfin_media_data");
    expect(volumes).toHaveProperty("jellyfin_config");
    expect(volumes).not.toHaveProperty("media_data");
    expect(volumes).not.toHaveProperty("config");

    // Service volume references should be prefixed too
    const services = getServices(result.compose);
    const svcVolumes = services.app.volumes as string[];
    expect(svcVolumes).toContain("jellyfin_media_data:/media");
    expect(svcVolumes).toContain("jellyfin_config:/config");
  });

  // ---------------------------------------------------------------------------
  // 6. Excluded services are removed
  // ---------------------------------------------------------------------------

  it("removes excluded services", () => {
    const input = makeInput({
      compose: {
        services: {
          app: { image: "myapp" },
          nginx: { image: "nginx" },
          db: { image: "postgres:16" },
        },
      },
      upstream: {
        source: "upstream/docker-compose.yml",
        services: { exclude: ["nginx"] },
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);

    expect(services).toHaveProperty("app");
    expect(services).toHaveProperty("db");
    expect(services).not.toHaveProperty("nginx");
  });

  // ---------------------------------------------------------------------------
  // 7. Relative bind mounts are rewritten
  // ---------------------------------------------------------------------------

  it("rewrites relative bind mount paths to upstream source directory", () => {
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          app: {
            image: "myapp:latest",
            volumes: [
              "./data:/app/data",
              "./config/app.conf:/etc/app.conf:ro",
              "/absolute/path:/data",
            ],
          },
        },
      },
      upstream: {
        source: "myapp-upstream/docker-compose.yml",
      },
      appsDir: "/opt/appbay/etc/apps",
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);
    const volumes = services.app.volumes as string[];

    // Relative paths should be rewritten relative to upstream source dir
    expect(volumes).toContain(
      "./apps/myapp/myapp-upstream/data:/app/data:z",
    );
    // An existing mode is PRESERVED and the label appended to it — `:ro` must not be
    // replaced, or a config mount silently becomes writable.
    expect(volumes).toContain(
      "./apps/myapp/myapp-upstream/config/app.conf:/etc/app.conf:ro,z",
    );
    // Absolute paths keep their source but still need the label
    // `:z` — every bind mount carries the shared SELinux relabel option now; without it
    // a container cannot read the source on an SELinux-enforcing host (Fedora/RHEL).
    expect(volumes).toContain("/absolute/path:/data:z");
  });

  // ---------------------------------------------------------------------------
  // 8. Two apps with same service names produce unique container names
  //    and volume prefixes
  // ---------------------------------------------------------------------------

  it("produces unique container names and volume prefixes for two apps with same service names", () => {
    const baseCompose = {
      services: {
        web: { image: "nginx", volumes: ["data:/var/data"] },
        db: { image: "postgres:16" },
      },
      volumes: { data: {} },
    };

    const inputA = makeInput({
      appName: "app_alpha",
      compose: structuredClone(baseCompose),
    });
    const inputB = makeInput({
      appName: "app_beta",
      compose: structuredClone(baseCompose),
    });

    const resultA = transformUpstream(inputA);
    const resultB = transformUpstream(inputB);

    const servicesA = getServices(resultA.compose);
    const servicesB = getServices(resultB.compose);

    // Container names must differ
    expect(servicesA.web.container_name).toBe("appbay.app_alpha.web");
    expect(servicesB.web.container_name).toBe("appbay.app_beta.web");
    expect(servicesA.db.container_name).toBe("appbay.app_alpha.db");
    expect(servicesB.db.container_name).toBe("appbay.app_beta.db");

    // Volume prefixes must differ
    const volumesA = getVolumes(resultA.compose);
    const volumesB = getVolumes(resultB.compose);
    expect(volumesA).toHaveProperty("app_alpha_data");
    expect(volumesB).toHaveProperty("app_beta_data");
    expect(volumesA).not.toHaveProperty("app_beta_data");
    expect(volumesB).not.toHaveProperty("app_alpha_data");

    // Internal networks must differ
    expect(resultA.internalNetwork).toBe("app_alpha_internal");
    expect(resultB.internalNetwork).toBe("app_beta_internal");
  });

  // ---------------------------------------------------------------------------
  // 9. Services not in expose list don't join shared network
  // ---------------------------------------------------------------------------

  it("does not add shared network to services not in expose list", () => {
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          web: { image: "nginx" },
          worker: { image: "worker:latest" },
        },
      },
      upstream: {
        source: "upstream/docker-compose.yml",
        expose: [{ service: "web", networks: ["appbay_shared"] }],
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);

    // web should be on appbay_shared
    const webNetworks = services.web.networks as Record<string, unknown>;
    expect(webNetworks).toHaveProperty("appbay_shared");

    // worker should NOT be on appbay_shared
    const workerNetworks = services.worker.networks as Record<string, unknown>;
    expect(workerNetworks).not.toHaveProperty("appbay_shared");
    expect(workerNetworks).toHaveProperty("myapp_internal");
  });

  // ---------------------------------------------------------------------------
  // 10. Empty expose list -> no services on shared network
  // ---------------------------------------------------------------------------

  it("does not add any services to shared network when expose is empty", () => {
    const input = makeInput({
      appName: "isolated",
      compose: {
        services: {
          app: { image: "myapp" },
          db: { image: "postgres:16" },
        },
      },
      upstream: {
        source: "upstream/docker-compose.yml",
        expose: [],
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);

    // No service should have appbay_shared in its networks
    for (const [, svc] of Object.entries(services)) {
      const networks = svc.networks as Record<string, unknown>;
      expect(networks).not.toHaveProperty("appbay_shared");
    }

    // exposedAliases should be empty
    expect(result.exposedAliases.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Additional: network_mode services don't get networks assigned
  // ---------------------------------------------------------------------------

  it("preserves network_mode and does not assign networks", () => {
    const input = makeInput({
      compose: {
        services: {
          vpn: { image: "gluetun", networks: { default: {} } },
          app: { image: "myapp", network_mode: "service:vpn" },
        },
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);

    // app should keep network_mode unchanged (no service rename)
    expect(services.app.network_mode).toBe("service:vpn");
    // app should not have networks assigned
    expect(services.app.networks).toBeUndefined();

    // vpn should have normal networks
    expect(services.vpn.networks).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Additional: env_file injection
  // ---------------------------------------------------------------------------

  it("injects app-level .env into env_file", () => {
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          app: { image: "myapp", env_file: ["./custom.env"] },
          worker: { image: "worker" },
        },
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);

    // ⚠️ BOTH injected entries are {path, required:false}, not bare strings. ac1b5f6
    // ("fix: .env required:false for upstreams without .env") made the app .env optional
    // too, because an upstream that ships no .env would otherwise make compose fail the
    // whole project on a file appbay injected rather than one the user wrote. These
    // assertions were written before that commit and were never updated, so they had been
    // failing ever since — asserting the OLD contract against the current code.
    const appEnvFile = services.app.env_file as Array<string | { path: string; required?: boolean }>;
    expect(appEnvFile[0]).toEqual({ path: "/opt/appbay/etc/apps/myapp/.env", required: false });
    expect(appEnvFile[1]).toEqual({ path: "/opt/appbay/etc/apps/myapp/.env.local", required: false });
    expect(appEnvFile).toContain("./custom.env");

    // worker had no env_file -- should be set
    const workerEnvFile = services.worker.env_file as Array<string | { path: string; required?: boolean }>;
    expect(workerEnvFile[0]).toEqual({ path: "/opt/appbay/etc/apps/myapp/.env", required: false });
    expect(workerEnvFile[1]).toEqual({ path: "/opt/appbay/etc/apps/myapp/.env.local", required: false });
    expect(workerEnvFile).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Additional: env_file as a plain string is converted to an array
  // ---------------------------------------------------------------------------

  it("converts string env_file to array and prepends the app .env", () => {
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          app: { image: "myapp", env_file: "./secrets.env" },
        },
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);

    const envFile = services.app.env_file as Array<string | { path: string; required?: boolean }>;
    // The app .env should be the first entry, .env.local second — both optional, see above.
    expect(envFile[0]).toEqual({ path: "/opt/appbay/etc/apps/myapp/.env", required: false });
    expect(envFile[1]).toEqual({ path: "/opt/appbay/etc/apps/myapp/.env.local", required: false });
    // Original string env_file should be preserved after
    expect(envFile).toContain("./secrets.env");
    expect(Array.isArray(envFile)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Additional: string expose entries (shorthand syntax)
  // ---------------------------------------------------------------------------

  it("handles expose entries as plain strings (shorthand form)", () => {
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          web: { image: "nginx" },
          api: { image: "api:latest" },
        },
      },
      upstream: {
        source: "upstream/compose.yml",
        // String form: each service joins the full sharedNetworks list
        expose: ["web"],
      },
      sharedNetworks: ["appbay_shared"],
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);

    // web should be on appbay_shared with alias
    const webNetworks = services.web.networks as Record<string, { aliases: string[] }>;
    expect(webNetworks.appbay_shared).toBeDefined();
    expect(webNetworks.appbay_shared.aliases).toContain("myapp_web");

    // api should NOT be on appbay_shared
    const apiNetworks = services.api.networks as Record<string, unknown>;
    expect(apiNetworks).not.toHaveProperty("appbay_shared");

    // exposedAliases reflects the string-form expose
    expect(result.exposedAliases.get("web")).toEqual(["myapp_web"]);
    expect(result.exposedAliases.has("api")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Additional: x- extension fields are preserved verbatim
  // ---------------------------------------------------------------------------

  it("preserves x- extension fields from the upstream compose", () => {
    const input = makeInput({
      compose: {
        services: { app: { image: "myapp" } },
        "x-common-env": { LOG_LEVEL: "info" },
        "x-healthcheck": { interval: "30s" },
      },
    });

    const result = transformUpstream(input);

    // Both x- fields should be carried into the output compose unchanged
    expect(result.compose["x-common-env"]).toEqual({ LOG_LEVEL: "info" });
    expect(result.compose["x-healthcheck"]).toEqual({ interval: "30s" });
  });

  // ---------------------------------------------------------------------------
  // Additional: expose as alias-map (Record<string, string>)
  // Third expose form: object without "service" key — each key is a service name
  // ---------------------------------------------------------------------------

  it("handles expose entries as alias-map objects (keys are service names)", () => {
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          web: { image: "nginx" },
          api: { image: "api:latest" },
        },
      },
      upstream: {
        source: "upstream/compose.yml",
        // Alias-map form: no "service" key — each key is a service name
        expose: [{ web: "web-alias" } as unknown as ExposeEntry],
      },
      sharedNetworks: ["appbay_shared"],
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);

    // "web" should be exposed on appbay_shared (joins sharedNetworks)
    const webNetworks = services.web.networks as Record<string, { aliases: string[] }>;
    expect(webNetworks.appbay_shared).toBeDefined();
    expect(webNetworks.appbay_shared.aliases).toContain("myapp_web");

    // "api" should NOT be on the shared network
    const apiNetworks = services.api.networks as Record<string, unknown>;
    expect(apiNetworks).not.toHaveProperty("appbay_shared");

    // exposedAliases should track "web"
    expect(result.exposedAliases.get("web")).toEqual(["myapp_web"]);
    expect(result.exposedAliases.has("api")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Additional: long-syntax volume — named volume (type: "volume")
  // ---------------------------------------------------------------------------

  it("prefixes named volume source in long-syntax volume entries", () => {
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          db: {
            image: "postgres:16",
            volumes: [
              { type: "volume", source: "pgdata", target: "/var/lib/postgresql/data" },
            ],
          },
        },
        volumes: { pgdata: {} },
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);
    const volumes = services.db.volumes as Array<{ type: string; source: string; target: string }>;

    const volEntry = volumes[0]!;
    // Long-syntax named volume source should be prefixed
    expect(volEntry.source).toBe("myapp_pgdata");
    expect(volEntry.target).toBe("/var/lib/postgresql/data");
    expect(volEntry.type).toBe("volume");
  });

  // ---------------------------------------------------------------------------
  // Additional: long-syntax volume — bind mount with relative source
  // ---------------------------------------------------------------------------

  it("rewrites relative source in long-syntax bind volume entries", () => {
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          app: {
            image: "myapp:latest",
            volumes: [
              { type: "bind", source: "./config", target: "/etc/app" },
            ],
          },
        },
      },
      upstream: {
        source: "myapp-upstream/docker-compose.yml",
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);
    const volumes = services.app.volumes as Array<{ type: string; source: string; target: string }>;

    const volEntry = volumes[0]!;
    // Long-syntax relative bind source should be rewritten
    expect(volEntry.source).toBe("./apps/myapp/myapp-upstream/config");
    expect(volEntry.target).toBe("/etc/app");
    expect(volEntry.type).toBe("bind");
  });

  // ---------------------------------------------------------------------------
  // Additional: long-syntax volume — non-relative bind source is left unchanged
  // ---------------------------------------------------------------------------

  it("does not rewrite absolute source in long-syntax bind volume entries", () => {
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          app: {
            image: "myapp:latest",
            volumes: [
              { type: "bind", source: "/absolute/host/path", target: "/data" },
            ],
          },
        },
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);
    const volumes = services.app.volumes as Array<{ type: string; source: string; target: string }>;

    // Absolute paths must not be modified
    expect(volumes[0]!.source).toBe("/absolute/host/path");
  });

  // ---------------------------------------------------------------------------
  // Additional: appsRelPath option changes the relative-path prefix
  // Branch: `prefix = appsRelPath ?? "apps"` — appsRelPath provided
  // ---------------------------------------------------------------------------

  it("uses appsRelPath prefix instead of legacy 'apps' when provided", () => {
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          app: {
            image: "myapp:latest",
            volumes: ["./data:/app/data"],
          },
        },
      },
      upstream: {
        source: "myapp-upstream/docker-compose.yml",
      },
      appsRelPath: "../../etc/apps",
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);
    const volumes = services.app.volumes as string[];

    // Should use the computed relative prefix, not the legacy "apps" fallback
    // `:z` — every bind mount carries the shared SELinux relabel option now; without it
    // a container cannot read the source on an SELinux-enforcing host (Fedora/RHEL).
    expect(volumes[0]).toBe("./../../etc/apps/myapp/myapp-upstream/data:/app/data:z");
  });

  // ---------------------------------------------------------------------------
  // Additional: short-syntax named volume NOT in originalVolumes → unchanged
  // Branch: `originalVolumes.has(source)` is false → `return vol`
  // ---------------------------------------------------------------------------

  it("leaves short-syntax named volume unchanged when not declared in top-level volumes", () => {
    // "undeclared_vol" exists in the service mount but not in top-level volumes:
    // → should NOT be prefixed, just passed through as-is.
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          app: {
            image: "myapp:latest",
            volumes: [
              "declared_vol:/data/declared",
              "undeclared_vol:/data/undeclared",
            ],
          },
        },
        volumes: {
          declared_vol: {},   // only this one is in originalVolumes
        },
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);
    const vols = services.app.volumes as string[];

    // declared_vol gets prefixed; undeclared_vol does not
    expect(vols).toContain("myapp_declared_vol:/data/declared");
    // 🚨 A NAMED VOLUME MUST NOT BE RELABELLED. `:z` on a named volume is meaningless at
    // best; the label option exists for bind mounts, whose SOURCE lives on the host
    // filesystem. Asserted because the fix that added it to bind mounts could so easily
    // have added it to everything.
    expect(vols).not.toContain("myapp_declared_vol:/data/declared:z");
    expect(vols).toContain("undeclared_vol:/data/undeclared");
  });

  // ---------------------------------------------------------------------------
  // Additional: short-syntax volume with no colon → unchanged
  // Branch: `parts.length >= 2` is false → `return vol`
  // ---------------------------------------------------------------------------

  it("leaves short-syntax volume entry with no colon unchanged", () => {
    // Some Compose files reference volume names without a target mount point.
    // These have no ":" so parts.length < 2 → fall through to return vol.
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          app: {
            image: "myapp:latest",
            volumes: ["bare_volume_name", "./data:/mounted"],
          },
        },
      },
      upstream: {
        source: "upstream/docker-compose.yml",
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);
    const vols = services.app.volumes as string[];

    // The bare volume name has no ":" — must be returned unchanged
    expect(vols).toContain("bare_volume_name");
    // The relative bind mount IS rewritten normally
    // `:z` — every bind mount carries the shared SELinux relabel option now; without it
    // a container cannot read the source on an SELinux-enforcing host (Fedora/RHEL).
    expect(vols).toContain("./apps/myapp/upstream/data:/mounted:z");
  });

  // ---------------------------------------------------------------------------
  // Additional: long-syntax named volume whose source is NOT in originalVolumes
  // Branch: `originalVolumes.has(transformed.source)` is false → no prefix
  // ---------------------------------------------------------------------------

  it("does not prefix long-syntax named volume source when not in originalVolumes", () => {
    const input = makeInput({
      appName: "myapp",
      compose: {
        services: {
          app: {
            image: "myapp:latest",
            volumes: [
              { type: "volume", source: "external_vol", target: "/data" },
            ],
          },
        },
        // external_vol is NOT declared here
        volumes: { declared_vol: {} },
      },
    });

    const result = transformUpstream(input);
    const services = getServices(result.compose);
    const vols = services.app.volumes as Array<{ type: string; source: string }>;

    // external_vol was not in originalVolumes → source must remain unchanged
    expect(vols[0]!.source).toBe("external_vol");
  });
});

// ---------------------------------------------------------------------------
// rewriteRelativePath — direct unit tests
// ---------------------------------------------------------------------------

describe("rewriteRelativePath", () => {
  // ── appsRelPath provided → use it instead of "apps" fallback ──────────────

  it("uses appsRelPath as the prefix when provided", () => {
    const result = rewriteRelativePath(
      "./config/traefik.yml",
      "traefik",
      "/opt/appbay/apps",
      "traefik-upstream/docker-compose.yml",
      "../../etc/apps",
    );

    expect(result).toBe("./../../etc/apps/traefik/traefik-upstream/config/traefik.yml");
  });

  it("falls back to 'apps' prefix when appsRelPath is omitted", () => {
    const result = rewriteRelativePath(
      "./config/traefik.yml",
      "traefik",
      "/opt/appbay/apps",
      "traefik-upstream/docker-compose.yml",
    );

    expect(result).toBe("./apps/traefik/traefik-upstream/config/traefik.yml");
  });

  // ── upstreamSource with no slash → upstreamDir is empty ──────────────────
  // Branch: `lastSlash = upstreamSource.lastIndexOf("/")` returns -1
  // → condition `if (lastSlash >= 0)` is false → upstreamDir stays ""

  it("omits upstreamDir from path when upstreamSource has no slash", () => {
    const result = rewriteRelativePath(
      "./data/file.txt",
      "myapp",
      "/opt/appbay/apps",
      "docker-compose.yml",   // no slash → lastSlash = -1
    );

    // With no upstreamDir, path is ./apps/myapp/data/file.txt
    expect(result).toBe("./apps/myapp/data/file.txt");
  });

  // ── upstreamSource undefined → upstreamDir is "" ─────────────────────────

  it("omits upstreamDir from path when upstreamSource is undefined", () => {
    const result = rewriteRelativePath(
      "./data/file.txt",
      "myapp",
      "/opt/appbay/apps",
      undefined,   // no source → upstreamDir stays ""
    );

    expect(result).toBe("./apps/myapp/data/file.txt");
  });

  // ── appsRelPath + no upstreamSource ──────────────────────────────────────

  it("combines appsRelPath prefix with no upstreamDir when source is undefined", () => {
    const result = rewriteRelativePath(
      "./volumes/db",
      "postgres",
      "/opt/appbay/apps",
      undefined,
      "../../../../etc/apps",
    );

    expect(result).toBe("./../../../../etc/apps/postgres/volumes/db");
  });
});
