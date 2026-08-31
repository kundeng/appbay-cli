import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { applyTraits } from "../trait-engine.js";
import type { TraitEngineInput, TraitEngineOutput } from "../trait-engine.js";
import { TraitRegistry } from "../../traits/registry.js";
import { registerCoreTraits } from "../../traits/definitions/index.js";
import type {
  TraitDefinition,
  TraitTransformInput,
  CompilerContext,
} from "../../traits/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal compiler context for testing. */
function makeContext(overrides?: Partial<CompilerContext>): CompilerContext {
  return {
    namespace: "default",
    appName: "test-app",
    appsDir: "/opt/appbay/etc/apps",
    runtimeFacts: {
      gpu: { available: false, cdiSupported: false },
      docker: {
        version: "24.0.7",
        composeVersion: "2.23.3",
        socketPath: "/var/run/docker.sock",
      },
      os: { platform: "linux", arch: "x64", version: "6.5.0" },
      disk: { availableGb: 100, totalGb: 500 },
      operatorId: "local",
    },
    ...overrides,
  };
}

/** Create a minimal trait definition for testing. */
function makeTrait(
  overrides: Partial<TraitDefinition> & { type: string },
): TraitDefinition {
  return {
    category: "core",
    scope: "service",
    conflictsWith: [],
    description: `Test trait: ${overrides.type}`,
    schema: z.object({ type: z.literal(overrides.type) }),
    transform: (input: TraitTransformInput) => ({ compose: input.compose }),
    ...overrides,
  };
}

/** Create a trait with a transform that appends a marker to compose.markers. */
function makeMarkerTrait(
  type: string,
  scope: "service" | "app" = "service",
  conflictsWith: string[] = [],
): TraitDefinition {
  return {
    type,
    category: "core",
    scope,
    conflictsWith,
    description: `Marker trait: ${type}`,
    schema: z.object({ type: z.literal(type) }),
    transform(input: TraitTransformInput) {
      const compose = { ...input.compose };
      const markers = ((compose.markers as string[]) ?? []).slice();
      markers.push(`${type}${input.service ? `:${input.service}` : ""}`);
      compose.markers = markers;
      return { compose };
    },
  };
}

/** Create a trait that produces auxiliary files. */
function makeAuxTrait(type: string): TraitDefinition {
  return {
    type,
    category: "core",
    scope: "service",
    conflictsWith: [],
    description: `Aux trait: ${type}`,
    schema: z.object({ type: z.literal(type) }),
    transform(input: TraitTransformInput) {
      return {
        compose: input.compose,
        auxiliaryFiles: [
          {
            path: `traefik/dynamic/${input.app}-${input.service ?? "app"}.yml`,
            content: `# config for ${type}`,
          },
        ],
      };
    },
  };
}

/** Simple base compose for tests. */
const BASE_COMPOSE: Record<string, unknown> = {
  services: {
    web: { image: "nginx" },
    api: { image: "node:20" },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyTraits (trait application engine)", () => {
  let registry: TraitRegistry;
  let context: CompilerContext;

  beforeEach(() => {
    registry = new TraitRegistry();
    context = makeContext();
  });

  // -------------------------------------------------------------------------
  // 1. Single app-level trait applied successfully
  // -------------------------------------------------------------------------
  /**
   * 🚨 THE REGRESSION: a typo in `service:` cost an app its only route, silently.
   *
   * `service: NOPE` on an ingress trait compiled clean — "1 compiled, 0 error(s)" — and
   * produced no route. The trait applied itself to nothing and said nothing, so the app
   * deployed, ran, and was simply unreachable. One misspelled word, no diagnostic.
   *
   * Checked once in the engine rather than per trait: every trait accepting `service` has
   * the same failure mode, and a per-trait check is one more thing to forget when the next
   * trait is written. Found by scripts/journeys/s26-journey-compile.sh (issue #70).
   */
  it("errors when an app-level trait targets a service the app does not define", () => {
    registerCoreTraits(registry);

    const output = applyTraits({
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [{ type: "backup", schedule: "0 2 * * *", service: "no_such_service" }],
      serviceTraits: {},
      registry,
      context,
    } as TraitEngineInput);

    expect(output.errors).toHaveLength(1);
    // The message must NAME the service — "invalid trait" would leave the operator
    // re-reading a manifest they already believe is correct.
    expect(output.errors[0].message).toContain("no_such_service");
    // …and name what IS available, because the fix is almost always a spelling correction.
    expect(output.errors[0].message).toContain("web");
    expect(output.errors[0].message).toContain("api");
  });

  it("accepts an app-level trait targeting a service the app does define", () => {
    registerCoreTraits(registry);

    const output = applyTraits({
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [{ type: "backup", schedule: "0 2 * * *", service: "web" }],
      serviceTraits: {},
      registry,
      context,
    } as TraitEngineInput);

    // Guards the obvious over-correction: rejecting every `service:` would be worse than
    // the bug, since service-scoped traits are a supported feature.
    expect(output.errors).toHaveLength(0);
  });

  it("applies a single app-level trait successfully with no errors", () => {
    registerCoreTraits(registry);

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [{ type: "backup", schedule: "0 2 * * *" }],
      serviceTraits: {},
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(0);
    expect(output.warnings).toHaveLength(0);
    // Stub transforms return compose unchanged.
    expect(output.compose).toEqual(BASE_COMPOSE);
  });

  // -------------------------------------------------------------------------
  // 2. Single service-level trait applied to correct service
  // -------------------------------------------------------------------------
  it("applies a single service-level trait to the correct service", () => {
    registry.register(makeMarkerTrait("test-svc", "service"));

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [],
      serviceTraits: {
        web: [{ type: "test-svc" }],
      },
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(0);
    const markers = output.compose.markers as string[];
    expect(markers).toEqual(["test-svc:web"]);
  });

  // -------------------------------------------------------------------------
  // 3. Multiple traits applied in declaration order
  // -------------------------------------------------------------------------
  it("applies multiple traits in declaration order", () => {
    registry.register(makeMarkerTrait("alpha", "app"));
    registry.register(makeMarkerTrait("beta", "app"));
    registry.register(makeMarkerTrait("gamma", "service"));
    registry.register(makeMarkerTrait("delta", "service"));

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [{ type: "alpha" }, { type: "beta" }],
      serviceTraits: {
        web: [{ type: "gamma" }, { type: "delta" }],
      },
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(0);
    const markers = output.compose.markers as string[];
    // App-level traits first (no service), then service-level traits.
    expect(markers).toEqual(["alpha", "beta", "gamma:web", "delta:web"]);
  });

  // -------------------------------------------------------------------------
  // 4. Unknown trait type produces error
  // -------------------------------------------------------------------------
  it("produces an error for unknown trait type", () => {
    registerCoreTraits(registry);

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [{ type: "nonexistent" }],
      serviceTraits: {},
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(1);
    expect(output.errors[0].trait).toBe("nonexistent");
    expect(output.errors[0].message).toContain("Unknown trait type");
    expect(output.errors[0].service).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 5. Duplicate trait type on same service produces error
  // -------------------------------------------------------------------------
  it("produces an error for duplicate trait type on the same service", () => {
    registerCoreTraits(registry);

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [],
      serviceTraits: {
        web: [
          { type: "ingress", host: "a.example.com", port: 80 },
          { type: "ingress", host: "b.example.com", port: 8080 },
        ],
      },
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(1);
    expect(output.errors[0].trait).toBe("ingress");
    expect(output.errors[0].service).toBe("web");
    expect(output.errors[0].message).toContain("Duplicate trait type");
    expect(output.errors[0].message).toContain("one configuration per trait type");
  });

  // -------------------------------------------------------------------------
  // 6. Conflicting traits produce error
  // -------------------------------------------------------------------------
  it("produces an error when conflicting traits are applied", () => {
    registry.register(
      makeMarkerTrait("trait-a", "service", ["trait-b"]),
    );
    registry.register(
      makeMarkerTrait("trait-b", "service", ["trait-a"]),
    );

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [],
      serviceTraits: {
        web: [{ type: "trait-a" }, { type: "trait-b" }],
      },
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(1);
    expect(output.errors[0].trait).toBe("trait-b");
    expect(output.errors[0].service).toBe("web");
    expect(output.errors[0].message).toContain("conflicts with");
    // trait-a should still have been applied (it was first, no conflict at that point).
    const markers = output.compose.markers as string[];
    expect(markers).toEqual(["trait-a:web"]);
  });

  // -------------------------------------------------------------------------
  // 7. Invalid trait properties produce schema validation error
  // -------------------------------------------------------------------------
  it("produces a schema validation error for invalid trait properties", () => {
    registerCoreTraits(registry);

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [],
      serviceTraits: {
        web: [
          // ingress requires `host` and `port`, both missing here.
          { type: "ingress" },
        ],
      },
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(1);
    expect(output.errors[0].trait).toBe("ingress");
    expect(output.errors[0].service).toBe("web");
    expect(output.errors[0].message).toContain("Schema validation failed");
    expect(output.errors[0].details).toBeDefined();
    // Details should contain Zod issue information.
    expect(Array.isArray(output.errors[0].details)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. App-level and service-level traits can coexist
  // -------------------------------------------------------------------------
  it("allows app-level and service-level traits to coexist", () => {
    registerCoreTraits(registry);

    // ⚠️ The GPU must be PRESENT in the facts for this test to be about coexistence.
    // The shared fixture reports `gpu: { available: false }`, and this test used to pass
    // with it — because an explicit `variant` skipped the host check entirely and warnings
    // had no producers, so `toHaveLength(0)` could not fail either way. Both of those are
    // fixed (#47), so the context now has to say what the test means.
    const gpuContext = makeContext({
      runtimeFacts: {
        ...context.runtimeFacts,
        gpu: { available: true, cdiSupported: false, vendor: "nvidia", devices: [] },
      },
    });

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [{ type: "backup", schedule: "0 2 * * *" }],
      serviceTraits: {
        web: [{ type: "ingress", host: "app.example.com", port: 8080 }],
        api: [{ type: "gpu", variant: "nvidia" }],
      },
      registry,
      context: gpuContext,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(0);
    expect(output.warnings).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 9. Empty traits list returns compose unchanged
  // -------------------------------------------------------------------------
  it("returns compose unchanged when no traits are provided", () => {
    registerCoreTraits(registry);

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [],
      serviceTraits: {},
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(0);
    expect(output.warnings).toHaveLength(0);
    expect(output.auxiliaryFiles).toHaveLength(0);
    expect(output.compose).toEqual(BASE_COMPOSE);
  });

  // -------------------------------------------------------------------------
  // 10. Auxiliary files from trait transforms are collected
  // -------------------------------------------------------------------------
  it("collects auxiliary files from trait transforms", () => {
    registry.register(makeAuxTrait("aux-trait"));

    const input: TraitEngineInput = {
      appName: "myapp",
      compose: { ...BASE_COMPOSE },
      appTraits: [],
      serviceTraits: {
        web: [{ type: "aux-trait" }],
        api: [{ type: "aux-trait" }],
      },
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(0);
    expect(output.auxiliaryFiles).toHaveLength(2);
    expect(output.auxiliaryFiles[0].path).toBe(
      "traefik/dynamic/myapp-web.yml",
    );
    expect(output.auxiliaryFiles[1].path).toBe(
      "traefik/dynamic/myapp-api.yml",
    );
    expect(output.auxiliaryFiles[0].content).toContain("aux-trait");
  });

  // -------------------------------------------------------------------------
  // 11. Trait metadata is collected from transform output
  // -------------------------------------------------------------------------
  it("collects traitMetadata from trait transforms", () => {
    const metaTrait: TraitDefinition = {
      type: "meta-trait",
      category: "core",
      scope: "app",
      conflictsWith: [],
      description: "Trait that emits metadata",
      schema: z.object({ type: z.literal("meta-trait") }),
      transform(input: TraitTransformInput) {
        return {
          compose: input.compose,
          metadata: {
            "meta-trait": { schedule: "0 3 * * *", retention: 7 },
          },
        };
      },
    };
    registry.register(metaTrait);

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [{ type: "meta-trait" }],
      serviceTraits: {},
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(0);
    expect(output.traitMetadata["meta-trait"]).toEqual({
      schedule: "0 3 * * *",
      retention: 7,
    });
  });

  it("collects backup trait metadata via core trait registration", () => {
    registerCoreTraits(registry);

    const input: TraitEngineInput = {
      appName: "myapp",
      compose: { ...BASE_COMPOSE },
      appTraits: [{ type: "backup", schedule: "0 2 * * *", retention: 14 }],
      serviceTraits: {},
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(0);
    const backupMeta = output.traitMetadata["backup"] as Record<string, unknown>;
    expect(backupMeta).toBeDefined();
    expect(backupMeta.app).toBe("myapp");
    expect(backupMeta.schedule).toBe("0 2 * * *");
    expect(backupMeta.retention).toBe(14);
  });

  it("returns empty traitMetadata when no traits emit metadata", () => {
    registry.register(makeMarkerTrait("marker", "app"));

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [{ type: "marker" }],
      serviceTraits: {},
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(0);
    expect(output.traitMetadata).toEqual({});
  });

  // -------------------------------------------------------------------------
  // App-level duplicate trait type produces error (mirrors service-level test 5)
  // -------------------------------------------------------------------------
  it("produces an error for duplicate trait type at app scope", () => {
    registry.register(makeMarkerTrait("app-trait", "app"));

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [
        { type: "app-trait" },
        { type: "app-trait" }, // duplicate
      ],
      serviceTraits: {},
      registry,
      context,
    };

    const output = applyTraits(input);

    // Second occurrence should produce a duplicate error.
    expect(output.errors).toHaveLength(1);
    expect(output.errors[0]!.trait).toBe("app-trait");
    expect(output.errors[0]!.message).toContain("Duplicate trait type");
    expect(output.errors[0]!.message).toContain("app scope");
    // First occurrence should still have been applied.
    const markers = output.compose.markers as string[];
    expect(markers).toEqual(["app-trait"]);
    // No service field on app-scope errors.
    expect(output.errors[0]!.service).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Unknown trait type at SERVICE level (mirrors test 4 which is app-level)
  // -------------------------------------------------------------------------
  it("produces an error (with service field) for unknown trait type at service scope", () => {
    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [],
      serviceTraits: {
        web: [{ type: "does-not-exist" }],
      },
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(1);
    expect(output.errors[0]!.trait).toBe("does-not-exist");
    expect(output.errors[0]!.service).toBe("web");
    expect(output.errors[0]!.message).toContain("Unknown trait type");
  });

  // -------------------------------------------------------------------------
  // App-level conflict check (mirrors test 6 which is service-level)
  // -------------------------------------------------------------------------
  it("produces an error when conflicting traits are applied at app scope", () => {
    registry.register(makeMarkerTrait("app-a", "app", ["app-b"]));
    registry.register(makeMarkerTrait("app-b", "app", ["app-a"]));

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      appTraits: [{ type: "app-a" }, { type: "app-b" }],
      serviceTraits: {},
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(1);
    expect(output.errors[0]!.trait).toBe("app-b");
    expect(output.errors[0]!.message).toContain("conflicts with");
    // No service field for app-scope errors.
    expect(output.errors[0]!.service).toBeUndefined();
    // First trait (app-a) was applied before the conflict was detected.
    const markers = output.compose.markers as string[];
    expect(markers).toEqual(["app-a"]);
  });

  // -------------------------------------------------------------------------
  // App-level schema validation failure (mirrors test 7 which is service-level)
  // -------------------------------------------------------------------------
  it("produces a schema validation error for invalid properties on an app-level trait", () => {
    registerCoreTraits(registry);

    const input: TraitEngineInput = {
      appName: "test-app",
      compose: { ...BASE_COMPOSE },
      // backup requires `schedule` (string) — omitting it triggers schema failure.
      appTraits: [{ type: "backup" }],
      serviceTraits: {},
      registry,
      context,
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(1);
    expect(output.errors[0]!.trait).toBe("backup");
    expect(output.errors[0]!.message).toContain("Schema validation failed");
    expect(Array.isArray(output.errors[0]!.details)).toBe(true);
    // App-level schema errors should NOT carry a service field.
    expect(output.errors[0]!.service).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 12. App-level trait with `service` field routes to correct compose service
  // -------------------------------------------------------------------------
  it("forwards service field from app-level trait config to transform input", () => {
    registerCoreTraits(registry);

    // GPU trait declared at app level with explicit `service: api` — this is
    // the pattern used by system app YAMLs (e.g. ollama appbay.yaml).
    const input: TraitEngineInput = {
      appName: "test-app",
      compose: {
        services: {
          web: { image: "nginx" },
          api: { image: "ollama/ollama" },
        },
      },
      appTraits: [{ type: "gpu", variant: "nvidia", service: "api" }],
      serviceTraits: {},
      registry,
      context: {
        ...context,
        runtimeFacts: {
          ...context.runtimeFacts,
          gpu: { available: true, cdiSupported: false, vendor: "nvidia", devices: [] },
        },
      },
    };

    const output = applyTraits(input);

    expect(output.errors).toHaveLength(0);
    // GPU trait should have mutated the `api` service with nvidia deploy config
    const apiSvc = (output.compose.services as Record<string, unknown>).api as Record<string, unknown>;
    const deploy = apiSvc.deploy as Record<string, unknown>;
    expect(deploy).toBeDefined();
    const reservations = (deploy.resources as Record<string, unknown>).reservations as Record<string, unknown>;
    expect(reservations.devices).toBeDefined();
  });
});
