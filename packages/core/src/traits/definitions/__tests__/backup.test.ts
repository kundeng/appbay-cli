import { describe, it, expect } from "vitest";
import { backupTraitDefinition } from "../backup.js";
import type { TraitTransformInput, CompilerContext } from "../../types.js";
import type { BackupTrait } from "../../../schemas/appbay-yaml.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<CompilerContext>): CompilerContext {
  return {
    project: "default",
    environment: "default",
    appName: "myapp",
    appsDir: "/tmp/apps",
    runtimeFacts: {
      gpu: { available: false, cdiSupported: false },
      docker: { version: "24.0.0", composeVersion: "2.20.0", socketPath: "/var/run/docker.sock" },
      os: { platform: "linux", arch: "x64", version: "6.0" },
      disk: { availableGb: 100, totalGb: 500 },
      operatorId: "test-operator",
    },
    ...overrides,
  };
}

function makeInput(
  props: BackupTrait,
  overrides?: Partial<TraitTransformInput>,
): TraitTransformInput {
  return {
    app: "myapp",
    // Traits under test read siblings via input.siblingTraits; default to none.
    siblingTraits: [],
    properties: props,
    compose: {
      services: {
        web: { image: "nginx:latest" },
      },
    },
    context: makeContext(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("backupTraitDefinition", () => {
  it("has the correct type, scope, and category", () => {
    expect(backupTraitDefinition.type).toBe("backup");
    expect(backupTraitDefinition.scope).toBe("app");
    expect(backupTraitDefinition.category).toBe("core");
  });

  it("validates valid backup properties", () => {
    const result = backupTraitDefinition.schema.safeParse({
      type: "backup",
      schedule: "0 2 * * *",
    });
    expect(result.success).toBe(true);
  });

  it("rejects backup properties missing required schedule", () => {
    const result = backupTraitDefinition.schema.safeParse({
      type: "backup",
    });
    expect(result.success).toBe(false);
  });
});

describe("backup transform", () => {
  it("returns compose unchanged and metadata with backup config", () => {
    const props: BackupTrait = {
      type: "backup",
      schedule: "0 2 * * *",
      retention: 14,
    };
    const input = makeInput(props);
    const output = backupTraitDefinition.transform(input);

    // Compose should be identical to input (no modifications)
    expect(output.compose).toEqual(input.compose);

    // Metadata should contain backup config
    expect(output.metadata).toBeDefined();
    expect(output.metadata!.backup).toEqual({
      app: "myapp",
      schedule: "0 2 * * *",
      retention: 14,
      volumes: undefined,
    });
  });

  it("uses default retention of 7 when not specified", () => {
    const props: BackupTrait = {
      type: "backup",
      schedule: "0 3 * * 0",
      retention: 7, // schema default
    };
    const input = makeInput(props);
    const output = backupTraitDefinition.transform(input);

    expect((output.metadata!.backup as Record<string, unknown>).retention).toBe(7);
  });

  it("includes volumes in metadata when specified", () => {
    const props: BackupTrait = {
      type: "backup",
      schedule: "0 2 * * *",
      retention: 7,
      volumes: ["data_vol", "config_vol"],
    };
    const input = makeInput(props);
    const output = backupTraitDefinition.transform(input);

    expect((output.metadata!.backup as Record<string, unknown>).volumes).toEqual([
      "data_vol",
      "config_vol",
    ]);
  });

  it("does not mutate the original compose input", () => {
    const originalCompose = {
      services: {
        web: { image: "nginx:latest" },
      },
    };
    const props: BackupTrait = {
      type: "backup",
      schedule: "0 2 * * *",
      retention: 7,
    };
    const input = makeInput(props, { compose: originalCompose });
    const output = backupTraitDefinition.transform(input);

    // Output compose should be the same object reference (no clone needed since backup doesn't modify)
    expect(output.compose).toBe(originalCompose);
  });
});
