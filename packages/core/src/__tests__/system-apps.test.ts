/**
 * Structural validation tests for the embedded SYSTEM_APPS catalog.
 *
 * The system app definitions are strings baked directly into the binary at
 * compile time. There is no IDE syntax-checking for embedded YAML, so a
 * bad indentation or missing colon won't surface until runtime. These tests
 * act as a compile-time safety net.
 *
 * Coverage:
 *   - Catalog completeness: expected system apps are all present
 *   - Unique names: no duplicates in the catalog
 *   - Required files: every app ships docker-compose.yml and appbay.yaml
 *   - Valid YAML: every file in every app parses without throwing
 *   - Compose structure: docker-compose.yml has a top-level `services` object
 *   - appbay.yaml schema: parses against AppbayYamlSchema (Zod safe-parse)
 *   - appbay.yaml scope: every app declares a non-empty project and environment
 */

import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { SYSTEM_APPS } from "../system-apps.js";
import { AppbayYamlSchema } from "../schemas/appbay-yaml.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Look up a system app by name; throws if missing (fail-fast). */
function getApp(name: string) {
  const app = SYSTEM_APPS.find((a) => a.name === name);
  if (!app) throw new Error(`System app "${name}" not found in SYSTEM_APPS`);
  return app;
}

/** Attempt to YAML-parse a string; returns the result or throws on syntax error. */
function yamlParse(content: string): unknown {
  return parseYaml(content);
}

// ---------------------------------------------------------------------------
// Catalog completeness
// ---------------------------------------------------------------------------

const EXPECTED_APPS = [
  "traefik",
  "caddy",
  "whoami",
  "sysinfo",
  "ollama",
  "open-webui",
  "vaultwarden",
  "homeassistant",
  "nextcloud",
  "jellyfin",
];

describe("SYSTEM_APPS catalog completeness", () => {
  it("contains all expected system apps", () => {
    const names = SYSTEM_APPS.map((a) => a.name);
    for (const expected of EXPECTED_APPS) {
      expect(names, `missing system app: ${expected}`).toContain(expected);
    }
  });

  it("has no duplicate app names", () => {
    const names = SYSTEM_APPS.map((a) => a.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("every entry has a non-empty name", () => {
    for (const app of SYSTEM_APPS) {
      expect(app.name, "app name must be a non-empty string").toBeTruthy();
      expect(typeof app.name).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Required files
// ---------------------------------------------------------------------------

describe("SYSTEM_APPS required files", () => {
  for (const app of SYSTEM_APPS) {
    it(`${app.name}: has docker-compose.yml`, () => {
      expect(Object.keys(app.files)).toContain("docker-compose.yml");
      expect(app.files["docker-compose.yml"]).toBeTruthy();
    });

    it(`${app.name}: has appbay.yaml`, () => {
      expect(Object.keys(app.files)).toContain("appbay.yaml");
      expect(app.files["appbay.yaml"]).toBeTruthy();
    });
  }
});

describe("sysinfo runtime portability", () => {
  it("uses a shell healthcheck that survives the Podman API compatibility path", () => {
    const compose = yamlParse(getApp("sysinfo").files["docker-compose.yml"]!) as {
      services: { sysinfo: { healthcheck: { test: string[] } } };
    };

    expect(compose.services.sysinfo.healthcheck.test[0]).toBe("CMD-SHELL");
    expect(compose.services.sysinfo.healthcheck.test).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Valid YAML syntax
// ---------------------------------------------------------------------------

describe("SYSTEM_APPS YAML syntax", () => {
  // ⚠️ SCOPED TO YAML FILES, and it did not used to be. Every system app carried only
  // .yml files until the caddy app arrived with a Caddyfile and a Dockerfile — neither
  // of which is YAML, and `yamlParse` on a Caddyfile throws on the first `{` block.
  //
  // The old form asserted "every file in every system app parses as YAML", which was a
  // true statement about the data rather than a rule anyone had chosen. Narrowing it to
  // the files that ARE YAML keeps the check that matters (a malformed compose file must
  // not ship) without forbidding system apps from carrying non-YAML config, which any
  // proxy that is not Traefik necessarily does.
  const isYaml = (path: string) => path.endsWith(".yml") || path.endsWith(".yaml");

  for (const app of SYSTEM_APPS) {
    for (const [filePath, content] of Object.entries(app.files)) {
      if (!isYaml(filePath)) continue;
      it(`${app.name}/${filePath}: parses without YAML syntax errors`, () => {
        expect(() => yamlParse(content)).not.toThrow();
      });
    }
  }

  it("every app still ships a parseable docker-compose.yml", () => {
    // The coverage the narrowing must not lose: skipping non-YAML must not become a way
    // for an app to ship no compose file at all.
    for (const app of SYSTEM_APPS) {
      expect(app.files["docker-compose.yml"], `${app.name} has no docker-compose.yml`).toBeDefined();
      expect(() => yamlParse(app.files["docker-compose.yml"]!)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Compose structure
// ---------------------------------------------------------------------------

describe("SYSTEM_APPS docker-compose.yml structure", () => {
  for (const app of SYSTEM_APPS) {
    it(`${app.name}: docker-compose.yml has a top-level 'services' object`, () => {
      const parsed = yamlParse(app.files["docker-compose.yml"]!) as Record<string, unknown>;
      expect(parsed).toBeTruthy();
      expect(typeof parsed).toBe("object");
      expect(parsed).toHaveProperty("services");
      const services = parsed["services"];
      expect(typeof services).toBe("object");
      expect(services).not.toBeNull();
      // At least one service defined
      expect(Object.keys(services as object).length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// appbay.yaml Zod schema validation
// ---------------------------------------------------------------------------

describe("SYSTEM_APPS appbay.yaml schema validation", () => {
  for (const app of SYSTEM_APPS) {
    it(`${app.name}: appbay.yaml passes AppbayYamlSchema`, () => {
      const rawParsed = yamlParse(app.files["appbay.yaml"]!);
      const result = AppbayYamlSchema.safeParse(rawParsed);
      if (!result.success) {
        // Format Zod errors for a readable failure message
        const issues = result.error.issues
          .map((i) => `  ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        throw new Error(
          `${app.name}/appbay.yaml failed schema validation:\n${issues}`,
        );
      }
      expect(result.success).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Scope completeness
// ---------------------------------------------------------------------------

describe("SYSTEM_APPS appbay.yaml scope fields", () => {
  for (const app of SYSTEM_APPS) {
    it(`${app.name}: declares a non-empty project`, () => {
      const rawParsed = yamlParse(app.files["appbay.yaml"]!) as Record<string, unknown>;
      const project = rawParsed["project"];
      expect(typeof project).toBe("string");
      expect((project as string).length).toBeGreaterThan(0);
    });

    it(`${app.name}: declares a non-empty environment`, () => {
      const rawParsed = yamlParse(app.files["appbay.yaml"]!) as Record<string, unknown>;
      const env = rawParsed["environment"];
      expect(typeof env).toBe("string");
      expect((env as string).length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Schema field correctness — collection vs group
// ---------------------------------------------------------------------------

describe("SYSTEM_APPS appbay.yaml field correctness", () => {
  it("no system app uses the invalid 'group' field (should be 'collection')", () => {
    for (const app of SYSTEM_APPS) {
      const rawParsed = yamlParse(app.files["appbay.yaml"]!) as Record<string, unknown>;
      expect(
        "group" in rawParsed,
        `${app.name}/appbay.yaml uses 'group' (invalid) — should use 'collection'`,
      ).toBe(false);
    }
  });

  it("system-tier apps declare collection: [system, ...]", () => {
    const systemApps = ["traefik", "caddy"];
    for (const name of systemApps) {
      const app = getApp(name);
      const rawParsed = yamlParse(app.files["appbay.yaml"]!) as {
        collection?: string[];
      };
      expect(
        rawParsed.collection,
        `${name} must declare a 'collection' array`,
      ).toBeDefined();
      expect(rawParsed.collection).toContain("system");
    }
  });
});

// ---------------------------------------------------------------------------
// Per-app spot checks
// ---------------------------------------------------------------------------

describe("SYSTEM_APPS per-app spot checks", () => {
  it("traefik: service is defined and uses traefik:v3.4 image", () => {
    const app = getApp("traefik");
    const compose = yamlParse(app.files["docker-compose.yml"]!) as {
      services: Record<string, { image?: string; depends_on?: unknown }>;
    };
    const traefik = compose.services["traefik"];
    expect(traefik).toBeDefined();
    // 🚨 FULLY QUALIFIED ON PURPOSE. Fedora/RHEL set short-name-mode = "enforcing" in
    // /etc/containers/registries.conf, so podman refuses to resolve a bare `traefik:v3.4`
    // and — with no TTY to prompt on — every deploy dies with
    //   "short-name resolution enforced but cannot prompt without a TTY".
    // Docker has no such concept and silently assumes docker.io, which is why this was
    // invisible until a RHEL-family host existed. `docker.io/library/` is the official-image
    // path and behaves identically on both runtimes.
    expect(traefik?.image).toBe("docker.io/library/traefik:v3.4");
    // socket-proxy depends_on was removed: it referenced a cross-compose service
    // which Docker Compose cannot resolve. Traefik uses a file provider, not Docker.
    expect(traefik?.depends_on).toBeUndefined();
  });

  it("caddy: compose defines the integrated Caddy edge service", () => {
    const app = getApp("caddy");
    const compose = yamlParse(app.files["docker-compose.yml"]!) as {
      services: Record<string, unknown>;
    };
    const serviceNames = Object.keys(compose.services);
    expect(serviceNames).toContain("caddy");
    expect(serviceNames).toHaveLength(1);
  });

  it("ollama: appbay.yaml declares a gpu trait", () => {
    const app = getApp("ollama");
    const rawParsed = yamlParse(app.files["appbay.yaml"]!) as {
      traits?: Array<{ type: string }>;
    };
    const traits = rawParsed.traits ?? [];
    const gpuTrait = traits.find((t) => t.type === "gpu");
    expect(gpuTrait).toBeDefined();
  });

  it("open-webui: appbay.yaml has at least one conditional overlay", () => {
    const app = getApp("open-webui");
    const rawParsed = yamlParse(app.files["appbay.yaml"]!) as {
      overlays?: Array<{ when: unknown }>;
    };
    expect(rawParsed.overlays).toBeDefined();
    expect((rawParsed.overlays ?? []).length).toBeGreaterThan(0);
  });

  it("open-webui: all overlays have a 'when' clause", () => {
    const app = getApp("open-webui");
    const rawParsed = yamlParse(app.files["appbay.yaml"]!) as {
      overlays?: Array<{ when?: unknown }>;
    };
    for (const overlay of rawParsed.overlays ?? []) {
      expect(overlay.when, "each overlay must have a 'when' clause").toBeDefined();
    }
  });

  it("vaultwarden: appbay.yaml declares a backup trait", () => {
    const app = getApp("vaultwarden");
    const rawParsed = yamlParse(app.files["appbay.yaml"]!) as {
      traits?: Array<{ type: string }>;
    };
    const backup = (rawParsed.traits ?? []).find((t) => t.type === "backup");
    expect(backup).toBeDefined();
  });

  it("homeassistant: appbay.yaml declares an init hooks trait", () => {
    const app = getApp("homeassistant");
    const rawParsed = yamlParse(app.files["appbay.yaml"]!) as {
      traits?: Array<{ type: string; pattern?: string }>;
    };
    const hooks = (rawParsed.traits ?? []).find((t) => t.type === "hooks");
    expect(hooks).toBeDefined();
    expect(hooks?.pattern).toBe("init");
  });

  it("homeassistant: compose defines mosquitto, zigbee2mqtt, and homeassistant services", () => {
    const app = getApp("homeassistant");
    const compose = yamlParse(app.files["docker-compose.yml"]!) as {
      services: Record<string, unknown>;
    };
    expect(Object.keys(compose.services)).toContain("mosquitto");
    expect(Object.keys(compose.services)).toContain("zigbee2mqtt");
    expect(Object.keys(compose.services)).toContain("homeassistant");
  });

  it("vaultwarden: appbay.yaml declares an ingress trait with exposure=external", () => {
    const app = getApp("vaultwarden");
    const rawParsed = yamlParse(app.files["appbay.yaml"]!) as {
      traits?: Array<{ type: string; exposure?: string }>;
    };
    const ingress = (rawParsed.traits ?? []).find((t) => t.type === "ingress");
    expect(ingress).toBeDefined();
    expect(ingress?.exposure).toBe("external");
  });

  it("nextcloud: compose defines db, redis, and nextcloud services", () => {
    const app = getApp("nextcloud");
    const compose = yamlParse(app.files["docker-compose.yml"]!) as {
      services: Record<string, unknown>;
    };
    expect(Object.keys(compose.services)).toContain("db");
    expect(Object.keys(compose.services)).toContain("redis");
    expect(Object.keys(compose.services)).toContain("nextcloud");
  });

  it("nextcloud: appbay.yaml declares a backup trait covering db and data volumes", () => {
    const app = getApp("nextcloud");
    const rawParsed = yamlParse(app.files["appbay.yaml"]!) as {
      traits?: Array<{ type: string; volumes?: string[] }>;
    };
    const backup = (rawParsed.traits ?? []).find((t) => t.type === "backup");
    expect(backup, "nextcloud must have a backup trait").toBeDefined();
    expect(backup?.volumes).toContain("nextcloud-db");
    expect(backup?.volumes).toContain("nextcloud-data");
  });

  it("jellyfin: compose mounts a media volume", () => {
    const app = getApp("jellyfin");
    const compose = yamlParse(app.files["docker-compose.yml"]!) as {
      services: Record<string, { volumes?: string[] }>;
    };
    const volumes = compose.services["jellyfin"]?.volumes ?? [];
    const hasMedia = volumes.some((v) => String(v).includes("/media"));
    expect(hasMedia, "jellyfin compose must bind-mount a /media path").toBe(true);
  });

  // ⚠️ The socket-proxy localhost-binding test was REMOVED, not repaired. socket-proxy was
  // deleted from SYSTEM_APPS in bd33800 ("socket-proxy removal"), so the test could only
  // ever throw "System app not found" — it was asserting a property of an app that no
  // longer exists, and had been red ever since.
  //
  // What replaces it is the check that would have caught what that removal actually broke.
  it("no system app depends_on a service its own compose file does not define", () => {
    // 🚨 THIS IS NOT A STYLE CHECK. Compose does not degrade on a dangling depends_on — it
    // REJECTS THE WHOLE PROJECT:
    //     service "traefik" depends on undefined service "socket-proxy": invalid compose
    //     project                                                                   (rc=1)
    // bd33800 removed socket-proxy and left `depends_on: [socket-proxy]` in traefik, so
    // appbay's DEFAULT INGRESS could not deploy at all — and nothing in the suite noticed,
    // because the only test naming socket-proxy was itself broken by the same commit.
    for (const app of SYSTEM_APPS) {
      const raw = app.files["docker-compose.yml"];
      if (!raw) continue;
      const compose = yamlParse(raw) as {
        services?: Record<string, { depends_on?: string[] | Record<string, unknown> }>;
      };
      const services = compose.services ?? {};
      const defined = new Set(Object.keys(services));

      for (const [name, svc] of Object.entries(services)) {
        const dep = svc?.depends_on;
        const deps = Array.isArray(dep) ? dep : dep ? Object.keys(dep) : [];
        for (const d of deps) {
          expect(
            defined.has(d),
            `${app.name}: service "${name}" depends_on "${d}", which its compose file does not define — compose will reject the entire project`,
          ).toBe(true);
        }
      }
    }
  });

  it("whoami: appbay.yaml declares an ingress trait with exposure=internal", () => {
    const app = getApp("whoami");
    const rawParsed = yamlParse(app.files["appbay.yaml"]!) as {
      traits?: Array<{ type: string; exposure?: string }>;
    };
    const ingress = (rawParsed.traits ?? []).find((t) => t.type === "ingress");
    expect(ingress, "whoami must have an ingress trait").toBeDefined();
    expect(
      ingress?.exposure,
      "whoami ingress must be internal-only (demo/health-check app)",
    ).toBe("internal");
  });

  it("open-webui: appbay.yaml declares provider-neutral auth intent", () => {
    const app = getApp("open-webui");
    const rawParsed = yamlParse(app.files["appbay.yaml"]!) as {
      traits?: Array<{ type: string; provider?: string; enabled?: boolean }>;
    };
    const auth = (rawParsed.traits ?? []).find((t) => t.type === "auth");
    expect(auth, "open-webui must have an auth trait (it exposes a user-facing UI)").toBeDefined();
    expect(auth?.provider, "user apps must not select an edge implementation").toBeUndefined();
    expect(auth?.enabled).toBe(true);
  });

  it("jellyfin: appbay.yaml declares an ingress trait with exposure=external", () => {
    const app = getApp("jellyfin");
    const rawParsed = yamlParse(app.files["appbay.yaml"]!) as {
      traits?: Array<{ type: string; exposure?: string }>;
    };
    const ingress = (rawParsed.traits ?? []).find((t) => t.type === "ingress");
    expect(ingress, "jellyfin must have an ingress trait").toBeDefined();
    expect(
      ingress?.exposure,
      "jellyfin ingress must be external (media server needs remote access)",
    ).toBe("external");
  });

  /**
   * 🚨 A SHORT IMAGE NAME BREAKS EVERY DEPLOY ON RHEL-FAMILY PODMAN. Fedora ships
   * short-name-mode = "enforcing", so an unqualified name must be resolved interactively;
   * in any automation there is no TTY and podman exits 125 with
   *   "short-name resolution enforced but cannot prompt without a TTY".
   * Docker assumes docker.io silently, so this class of breakage cannot be seen on Ubuntu
   * — it was found only once a Fedora host existed (S25 task 20).
   *
   * Two spot checks cannot hold this line; the property is "every image, every app".
   */
  it("every system app fully qualifies its image registry", () => {
    const unqualified: string[] = [];
    for (const app of SYSTEM_APPS) {
      const compose = app.files["docker-compose.yml"];
      if (!compose) continue;
      for (const m of compose.matchAll(/^\s*image:\s*([^\s#]+)/gm)) {
        const image = m[1];
        // Registry-qualified (has a dot or is localhost before the first slash), or a
        // variable the operator supplies — both are fine.
        if (image.includes("${")) continue;
        const segments = image.split("/");
        // ⚠️ NO SLASH MEANS NO REGISTRY, whatever the tag looks like. An earlier version of
        // this guard tested `head.includes(".")` first and so accepted `traefik:v3.4` — the
        // dot came from the TAG, not a hostname — which made the guard pass on exactly the
        // input it exists to reject. Check the slash before looking for a dot.
        if (segments.length > 1) {
          const head = segments[0];
          if (head.includes(".") || head.includes(":") || head === "localhost") continue;
        }
        unqualified.push(`${app.name}: ${image}`);
      }
    }
    expect(unqualified).toEqual([]);
  });

  it("ollama: compose defines an ollama service with GPU-capable image", () => {
    const app = getApp("ollama");
    const compose = yamlParse(app.files["docker-compose.yml"]!) as {
      services: Record<string, { image?: string }>;
    };
    const svc = compose.services["ollama"];
    expect(svc, "ollama service must be defined").toBeDefined();
    expect(svc?.image).toMatch(/^docker\.io\/ollama\/ollama/);
  });
});
