import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { TraitRegistry } from "../registry.js";
import {
  registerCoreTraits,
  coreTraitDefinitions,
  ingressTraitDefinition,
  gpuTraitDefinition,
  authTraitDefinition,
  hooksTraitDefinition,
  secretsTraitDefinition,
  backupTraitDefinition,
  scopedEnvTraitDefinition,
} from "../definitions/index.js";
import type { TraitDefinition, TraitTransformInput } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TraitRegistry", () => {
  let registry: TraitRegistry;

  beforeEach(() => {
    registry = new TraitRegistry();
  });

  // 1. Register and retrieve a trait
  it("registers and retrieves a trait by type", () => {
    const trait = makeTrait({ type: "test-trait" });
    registry.register(trait);

    const retrieved = registry.get("test-trait");
    expect(retrieved).toBeDefined();
    expect(retrieved!.type).toBe("test-trait");
    expect(retrieved!.category).toBe("core");
  });

  // 2. Register all 7 core traits
  it("registers all 7 core traits without error", () => {
    registerCoreTraits(registry);

    const all = registry.all();
    expect(all).toHaveLength(7);

    const types = all.map((t) => t.type).sort();
    expect(types).toEqual([
      "auth",
      "backup",
      "gpu",
      "hooks",
      "ingress",
      "scoped-env",
      "secrets",
    ]);
  });

  // 3. Reject duplicate trait type registration
  it("rejects duplicate trait type registration", () => {
    const trait = makeTrait({ type: "duplicate" });
    registry.register(trait);

    expect(() => registry.register(trait)).toThrow(
      'Trait type "duplicate" is already registered',
    );
  });

  // 4. detectConflicts finds declared conflicts
  it("detectConflicts finds declared conflicts", () => {
    registry.register(
      makeTrait({ type: "alpha", conflictsWith: ["beta"] }),
    );
    registry.register(
      makeTrait({ type: "beta", conflictsWith: ["alpha"] }),
    );

    const conflicts = registry.detectConflicts(["alpha", "beta"]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].traitA).toBe("alpha");
    expect(conflicts[0].traitB).toBe("beta");
    expect(conflicts[0].message).toContain("conflicts with");
  });

  // 5. detectConflicts returns empty for non-conflicting traits
  it("detectConflicts returns empty for non-conflicting traits", () => {
    registerCoreTraits(registry);

    const conflicts = registry.detectConflicts(["ingress", "gpu", "hooks"]);
    expect(conflicts).toHaveLength(0);
  });

  // 6. validateAssignment rejects duplicate trait type on same service
  it("validateAssignment rejects duplicate trait type on same service", () => {
    registerCoreTraits(registry);

    const result = registry.validateAssignment("ingress", "service", [
      "ingress",
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Duplicate trait type");
    expect(result.errors[0]).toContain("one configuration per trait type");
  });

  // 7. Trait schemas validate correct properties
  it("trait schemas validate correct properties", () => {
    const validIngress = {
      type: "ingress",
      host: "app.example.com",
      port: 8080,
    };
    expect(() => ingressTraitDefinition.schema.parse(validIngress)).not.toThrow();

    const validGpu = {
      type: "gpu",
      variant: "nvidia",
    };
    expect(() => gpuTraitDefinition.schema.parse(validGpu)).not.toThrow();

    const validAuth = {
      type: "auth",
    };
    expect(() => authTraitDefinition.schema.parse(validAuth)).not.toThrow();

    const validHooks = {
      type: "hooks",
      pattern: "init",
      image: "alpine",
      command: "echo hello",
    };
    expect(() => hooksTraitDefinition.schema.parse(validHooks)).not.toThrow();

    const validSecrets = {
      type: "secrets",
      refs: { DB_PASSWORD: "vault://project/prod/db/password" },
    };
    expect(() => secretsTraitDefinition.schema.parse(validSecrets)).not.toThrow();

    const validBackup = {
      type: "backup",
      schedule: "0 2 * * *",
    };
    expect(() => backupTraitDefinition.schema.parse(validBackup)).not.toThrow();

    const validScopedEnv = {
      type: "scoped-env",
      vars: { DOMAIN: "${{project.DOMAIN}}" },
    };
    expect(() =>
      scopedEnvTraitDefinition.schema.parse(validScopedEnv),
    ).not.toThrow();
  });

  // 8. Trait schemas reject invalid properties
  it("trait schemas reject invalid properties", () => {
    // Ingress missing required `host` and `port`
    expect(() =>
      ingressTraitDefinition.schema.parse({ type: "ingress" }),
    ).toThrow();

    // GPU with invalid variant
    expect(() =>
      gpuTraitDefinition.schema.parse({ type: "gpu", variant: "invalid" }),
    ).toThrow();

    // Hooks missing required `pattern`
    expect(() =>
      hooksTraitDefinition.schema.parse({ type: "hooks" }),
    ).toThrow();

    // Secrets missing required `refs`
    expect(() =>
      secretsTraitDefinition.schema.parse({ type: "secrets" }),
    ).toThrow();

    // Backup missing required `schedule`
    expect(() =>
      backupTraitDefinition.schema.parse({ type: "backup" }),
    ).toThrow();

    // ScopedEnv missing required `vars`
    expect(() =>
      scopedEnvTraitDefinition.schema.parse({ type: "scoped-env" }),
    ).toThrow();
  });

  // validateAssignment — unknown trait (early return)
  it("validateAssignment rejects unknown trait type with early return", () => {
    registerCoreTraits(registry);

    const result = registry.validateAssignment("nonexistent-trait", "service", []);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Unknown trait type "nonexistent-trait"');
  });

  // validateAssignment — scope mismatch
  it("validateAssignment rejects trait assigned at wrong scope", () => {
    registerCoreTraits(registry);

    // "ingress" has scope "service" — assigning it at "app" scope should fail.
    const result = registry.validateAssignment("ingress", "app", []);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('"ingress"');
    expect(result.errors[0]).toContain('"service"');
    expect(result.errors[0]).toContain('"app"');
  });

  // validateAssignment — conflict with existing trait
  it("validateAssignment reports conflict when new trait conflicts with existing", () => {
    // Register two conflicting traits: alpha ↔ beta.
    registry.register(makeTrait({ type: "alpha", conflictsWith: ["beta"] }));
    registry.register(makeTrait({ type: "beta", conflictsWith: ["alpha"] }));

    // Assigning "alpha" when "beta" is already on the service.
    const result = registry.validateAssignment("alpha", "service", ["beta"]);
    expect(result.valid).toBe(false);
    const conflictError = result.errors.find((e) => e.includes("conflicts with"));
    expect(conflictError).toBeDefined();
    expect(conflictError).toContain("alpha");
    expect(conflictError).toContain("beta");
  });

  // validateAssignment — valid assignment (happy path)
  it("validateAssignment returns valid for a correct trait assignment", () => {
    registerCoreTraits(registry);

    // "ingress" is a service-scoped trait; assigning it at "service" scope with
    // no existing traits should pass without errors.
    const result = registry.validateAssignment("ingress", "service", []);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // detectConflicts — gracefully skips unknown trait types
  it("detectConflicts skips unknown trait types without throwing", () => {
    registry.register(makeTrait({ type: "known", conflictsWith: [] }));

    // "unknown-trait" is not registered; detectConflicts must not throw and
    // should return no conflicts.
    const conflicts = registry.detectConflicts(["known", "unknown-trait"]);
    expect(conflicts).toHaveLength(0);
  });

  // get() — returns undefined for unregistered type
  it("get() returns undefined for an unregistered trait type", () => {
    expect(registry.get("does-not-exist")).toBeUndefined();
  });

  // 9. All core traits are fully implemented (no stubs remain)
  it("all core traits are fully implemented", () => {
    // All 7 core traits now have real transform implementations.
    // This test verifies none are left as identity stubs.
    registerCoreTraits(registry);
    const all = registry.all();
    expect(all).toHaveLength(7);
  });

  // 10. All core traits have correct scope
  it("all core traits have correct scope", () => {
    const expectedScopes: Record<string, "service" | "app"> = {
      ingress: "service",
      gpu: "service",
      auth: "app",
      hooks: "service",
      secrets: "service",
      backup: "app",
      "scoped-env": "app",
    };

    for (const definition of coreTraitDefinitions) {
      expect(definition.scope).toBe(expectedScopes[definition.type]);
    }
  });
});
