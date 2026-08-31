import { describe, it, expect } from "vitest";
import { AppbayYamlSchema, TraitConfigSchema } from "../appbay-yaml.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse and return the result, expecting success. */
function parse(input: unknown) {
  return AppbayYamlSchema.parse(input);
}

/** Safely parse and return the ZodSafeParseReturnType. */
function safeParse(input: unknown) {
  return AppbayYamlSchema.safeParse(input);
}

// ---------------------------------------------------------------------------
// 1. Minimal appbay.yaml (just upstream.source)
// ---------------------------------------------------------------------------

describe("minimal appbay.yaml", () => {
  it("parses an empty object with defaults", () => {
    const result = parse({});
    // RFC-001 §4: absence must be EXPRESSIBLE. `namespace` is `.optional()`, not
    // `.default("default")` — a default here is what made the invocation value unreachable
    // in compile.ts, because `config?.namespace ?? invocation` could never see undefined.
    expect(result.namespace).toBeUndefined();
    expect(result.shared_network).toEqual(["appbay_shared"]);
  });

  it("parses with only upstream.source", () => {
    const result = parse({
      upstream: { source: "./jellyfin-upstream/docker-compose.yml" },
    });
    expect(result.upstream?.source).toBe(
      "./jellyfin-upstream/docker-compose.yml",
    );
    expect(result.namespace).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Standard appbay.yaml (upstream + ingress + gpu traits)
// ---------------------------------------------------------------------------

describe("standard appbay.yaml", () => {
  it("parses upstream with ingress and gpu traits", () => {
    const result = parse({
      namespace: "homelab",
      upstream: {
        source: "./jellyfin-upstream/docker-compose.yml",
        expose: [{ service: "jellyfin", networks: ["proxy"] }],
      },
      services: {
        jellyfin: {
          traits: [
            {
              type: "ingress",
              host: "media.example.com",
              port: 8096,
            },
            {
              type: "gpu",
              variant: "nvidia",
            },
          ],
        },
      },
    });

    expect(result.namespace).toBe("homelab");
    expect(result.services?.jellyfin?.traits).toHaveLength(2);

    const ingress = result.services!.jellyfin!.traits![0]!;
    expect(ingress.type).toBe("ingress");
    if (ingress.type === "ingress") {
      expect(ingress.host).toBe("media.example.com");
      expect(ingress.port).toBe(8096);
      expect(ingress.exposure).toBe("both"); // default
    }

    const gpu = result.services!.jellyfin!.traits![1]!;
    expect(gpu.type).toBe("gpu");
    if (gpu.type === "gpu") {
      expect(gpu.variant).toBe("nvidia");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Complex appbay.yaml (overlays with AND/OR, policies, service-level traits)
// ---------------------------------------------------------------------------

describe("complex appbay.yaml", () => {
  it("parses overlays with AND (array) when clause", () => {
    const result = parse({
      overlays: [
        {
          when: ["caddy", "ollama"],
          services: {
            jellyfin: {
              labels: { "traefik.enable": "true" },
            },
          },
        },
      ],
    });

    expect(result.overlays).toHaveLength(1);
    expect(result.overlays![0]!.when).toEqual(["caddy", "ollama"]);
  });

  it("parses overlays with OR ({any}) when clause", () => {
    const result = parse({
      overlays: [
        {
          when: { any: ["grafana", "prometheus"] },
          services: {
            app: { environment: { METRICS: "true" } },
          },
        },
      ],
    });

    const when = result.overlays![0]!.when;
    expect(when).toEqual({ any: ["grafana", "prometheus"] });
  });

  it("parses policies with conflict declarations", () => {
    const result = parse({
      policies: {
        conflicts: [
          { traits: ["ingress", "gpu"], action: "warn" },
          { traits: ["auth", "secrets"] },
        ],
      },
    });

    expect(result.policies?.conflicts).toHaveLength(2);
    expect(result.policies!.conflicts![0]!.action).toBe("warn");
    expect(result.policies!.conflicts![1]!.action).toBe("error"); // default
  });

  it("parses service-level traits alongside app-level traits", () => {
    const result = parse({
      traits: [
        {
          type: "backup",
          schedule: "0 3 * * *",
          retention: 14,
        },
      ],
      services: {
        ollama: {
          traits: [
            {
              type: "gpu",
              variant: "cdi",
              devices: ["nvidia.com/gpu=all"],
            },
          ],
        },
      },
    });

    expect(result.traits).toHaveLength(1);
    expect(result.traits![0]!.type).toBe("backup");
    expect(result.services?.ollama?.traits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Invalid configs produce actionable errors with field paths
// ---------------------------------------------------------------------------

describe("validation errors", () => {
  it("rejects invalid trait type in discriminated union", () => {
    const result = safeParse({
      traits: [{ type: "nonexistent", foo: "bar" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The error should reference the traits path
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("traits"))).toBe(true);
    }
  });

  it("rejects ingress trait missing required host", () => {
    const result = safeParse({
      services: {
        app: {
          traits: [{ type: "ingress", port: 8080 }],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects gpu trait with invalid variant", () => {
    const result = safeParse({
      services: {
        app: {
          traits: [{ type: "gpu", variant: "intel" }],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects overlay missing when clause", () => {
    const result = safeParse({
      overlays: [{ services: { app: {} } }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects overlay with mixed AND+OR when clause (not supported in schema)", () => {
    // WhenClauseSchema is z.union([z.array(z.string()), z.object({any: ...})]).
    // A mixed array like [string, {any: [...]}] matches neither branch.
    // Use two separate overlays to achieve AND+OR logic instead.
    const result = safeParse({
      overlays: [
        {
          when: ["caddy", { any: ["ollama", "llamacpp"] }],
          services: { web: { environment: ["AUTH=true"] } },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Validate defaults
// ---------------------------------------------------------------------------

describe("defaults", () => {
  it("leaves namespace undefined rather than defaulting it", () => {
    // The keystone of RFC-001 §4. If this ever goes back to a default, every
    // `appbay up --namespace X` is silently ignored again.
    const result = parse({});
    expect(result.namespace).toBeUndefined();
    expect("namespace" in result).toBe(false);
  });

  it("rejects a NON-DEFAULT removed scope field instead of dropping it", () => {
    // Zod strips unknown keys, so without an explicit rule `project: homelab` would parse
    // clean and the value would vanish with no error — the trap this guards.
    for (const [field, value] of [["project", "homelab"], ["environment", "prod"]] as const) {
      const result = AppbayYamlSchema.safeParse({ [field]: value });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]!.message).toContain("removed in RFC-001");
        expect(result.error.issues[0]!.message).toContain("namespace");
      }
    }
  });

  it("accepts the removed fields when they say 'default' — that value carried nothing", () => {
    // All 162 declarations across both catalogs and system-apps said `default`. Rejecting
    // them would fail every existing manifest to report a value that never did anything.
    const result = AppbayYamlSchema.safeParse({ project: "default", environment: "default" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.namespace).toBeUndefined();
  });

  it("keeps an explicitly declared namespace", () => {
    expect(parse({ namespace: "uom.sim" }).namespace).toBe("uom.sim");
  });

  it("applies default shared_network=['appbay_shared']", () => {
    const result = parse({});
    expect(result.shared_network).toEqual(["appbay_shared"]);
  });

  it("applies default exposure='both' on ingress trait", () => {
    const result = parse({
      services: {
        app: {
          traits: [{ type: "ingress", host: "app.example.com", port: 80 }],
        },
      },
    });
    const trait = result.services!.app!.traits![0]!;
    if (trait.type === "ingress") {
      expect(trait.exposure).toBe("both");
    }
  });

  it("keeps auth intent provider-neutral and applies behavioral defaults", () => {
    const result = parse({
      traits: [{ type: "auth", provider: "legacy-provider-field-is-ignored" }],
    });
    const trait = result.traits![0]!;
    if (trait.type === "auth") {
      expect("provider" in trait).toBe(false);
      expect(trait.enabled).toBe(true);
      expect(trait.policy).toBe("authenticated");
    }
  });

  it("applies default retention=7 on backup trait", () => {
    const result = parse({
      traits: [{ type: "backup", schedule: "0 3 * * *" }],
    });
    const trait = result.traits![0]!;
    if (trait.type === "backup") {
      expect(trait.retention).toBe(7);
    }
  });

  it("rejects a non-vault provider and a non-vault ref — RFC-001 §3.2", () => {
    // The backend is an installation choice, not a manifest one. Before this, the enum
    // accepted five values and any scheme was allowed in `refs`, so a manifest written
    // against one backend broke on the other — for a field that never selected anything:
    // resolution has always keyed off the URI scheme, and `provider:` was metadata.
    for (const trait of [
      { type: "secrets", provider: "keepass", refs: { A: "vault://app/A" } },
      { type: "secrets", refs: { A: "keepass://app/A" } },
      { type: "secrets", refs: { A: "sops://app/A" } },
      { type: "secrets", refs: { A: "file:///tmp/a" } },
      { type: "secrets", refs: { A: "env://A" } },
    ]) {
      expect(TraitConfigSchema.safeParse(trait).success).toBe(false);
    }
    // …and the permitted shape still parses.
    expect(
      TraitConfigSchema.safeParse({ type: "secrets", refs: { A: "vault://app/A" } }).success,
    ).toBe(true);
  });

  it("applies default provider='vault' on secrets trait", () => {
    const result = parse({
      traits: [{ type: "secrets", refs: { DB_PASS: "vault://DB_PASS" } }],
    });
    const trait = result.traits![0]!;
    if (trait.type === "secrets") {
      expect(trait.provider).toBe("vault");
      expect(trait.injection).toBe("runtime-env");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Validate multi-valued collection field
// ---------------------------------------------------------------------------

describe("multi-valued collection field", () => {
  it("accepts collection as an array of strings", () => {
    const result = parse({ collection: ["media", "monitoring"] });
    expect(result.collection).toEqual(["media", "monitoring"]);
  });

  it("accepts collection as undefined (optional)", () => {
    const result = parse({});
    expect(result.collection).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Discriminated union rejects unknown trait types
// ---------------------------------------------------------------------------

describe("discriminated union", () => {
  it("rejects unknown trait type", () => {
    const result = TraitConfigSchema.safeParse({
      type: "unknown-trait",
      foo: "bar",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all known trait types", () => {
    const knownTypes = [
      { type: "ingress", host: "x.com", port: 80 },
      { type: "gpu", variant: "nvidia" },
      { type: "auth" },
      { type: "hooks", pattern: "init" },
      { type: "secrets", refs: { A: "vault://app/A" } },
      { type: "backup", schedule: "0 * * * *" },
      { type: "scoped-env", vars: { FOO: "${{project.FOO}}" } },
    ];

    for (const trait of knownTypes) {
      const result = TraitConfigSchema.safeParse(trait);
      expect(
        result.success,
        `Expected trait type '${trait.type}' to be valid`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 8a. App-level trait `service` routing field preserved through schema parsing
// ---------------------------------------------------------------------------
//
// Regression guard: TraitConfigSchema (discriminated union) runs during
// AppbayYamlSchema.safeParse() in discover.ts. Without `service` in the
// individual trait schemas, Zod silently strips it before the trait engine
// ever receives the config — breaking app-level gpu/ingress/hooks routing.
//
// These tests verify the field survives both TraitConfigSchema and the full
// AppbayYamlSchema parse pass.
//

describe("app-level trait `service` routing field preservation", () => {
  it("preserves `service` field in GpuTraitSchema through TraitConfigSchema", () => {
    const result = TraitConfigSchema.safeParse({
      type: "gpu",
      variant: "nvidia",
      service: "ollama",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).service).toBe("ollama");
    }
  });

  it("preserves `service` field in IngressTraitSchema through TraitConfigSchema", () => {
    const result = TraitConfigSchema.safeParse({
      type: "ingress",
      host: "app.example.com",
      port: 8080,
      service: "web",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).service).toBe("web");
    }
  });

  it("preserves `service` field in HooksTraitSchema through TraitConfigSchema", () => {
    const result = TraitConfigSchema.safeParse({
      type: "hooks",
      pattern: "init",
      image: "alpine:latest",
      service: "db",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).service).toBe("db");
    }
  });

  it("preserves gpu `service` field through full AppbayYamlSchema parse", () => {
    const result = AppbayYamlSchema.safeParse({
      traits: [{ type: "gpu", variant: "nvidia", service: "ollama" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const trait = result.data.traits?.[0] as Record<string, unknown>;
      expect(trait?.service).toBe("ollama");
    }
  });

  it("preserves hooks `service` field through full AppbayYamlSchema parse", () => {
    const result = AppbayYamlSchema.safeParse({
      traits: [{ type: "hooks", pattern: "init", service: "api" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const trait = result.data.traits?.[0] as Record<string, unknown>;
      expect(trait?.service).toBe("api");
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Full round-trip: complex config parses and infers correct types
// ---------------------------------------------------------------------------

describe("full config round-trip", () => {
  it("parses a complete realistic config", () => {
    const input = {
      namespace: "homelab",
      collection: ["media"],
      operator: "node-1",
      shared_network: ["appbay_shared", "proxy"],
      tags: { tier: "gold", region: "us-east" },

      upstream: {
        source: "./jellyfin-upstream/docker-compose.yml",
        services: { exclude: ["nginx"] },
        expose: [
          { service: "jellyfin", networks: ["proxy", "appbay_shared"] },
        ],
      },

      overrides: {
        jellyfin: {
          environment: { TZ: "America/New_York" },
        },
      },

      overlays: [
        {
          when: ["traefik"],
          services: {
            jellyfin: { networks: { proxy: {} } },
          },
        },
        {
          when: { any: ["grafana", "prometheus"] },
          services: {
            jellyfin: { environment: { METRICS_PORT: "9090" } },
          },
        },
      ],

      traits: [
        { type: "backup", schedule: "0 3 * * *" },
        { type: "auth", enabled: true },
      ],

      services: {
        jellyfin: {
          traits: [
            { type: "ingress", host: "media.example.com", port: 8096 },
            { type: "gpu", variant: "nvidia", count: 1 },
            {
              type: "scoped-env",
              vars: {
                DOMAIN: "${{project.DOMAIN}}",
                DB_PASS: "${password:32}",
              },
            },
          ],
        },
      },

      policies: {
        conflicts: [
          { traits: ["ingress", "gpu"], action: "warn" },
        ],
      },
    };

    const result = parse(input);

    expect(result.namespace).toBe("homelab");
    expect(result.shared_network).toEqual(["appbay_shared", "proxy"]);
    expect(result.upstream?.services?.exclude).toEqual(["nginx"]);
    expect(result.overlays).toHaveLength(2);
    expect(result.traits).toHaveLength(2);
    expect(result.services?.jellyfin?.traits).toHaveLength(3);
    expect(result.policies?.conflicts).toHaveLength(1);
  });
});
