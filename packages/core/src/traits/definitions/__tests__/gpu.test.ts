import { describe, it, expect } from "vitest";
import { gpuTraitDefinition, resolveVariant } from "../gpu.js";
import type { TraitTransformInput, CompilerContext } from "../../types.js";
import type { GpuTrait } from "../../../schemas/appbay-yaml.js";
import type { GpuFacts } from "../../../schemas/runtime-facts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  gpuOverrides?: Partial<GpuFacts>,
): CompilerContext {
  return {
    project: "default",
    environment: "default",
    appName: "myapp",
    appsDir: "/tmp/apps",
    runtimeFacts: {
      gpu: {
        available: true,
        vendor: "nvidia",
        cdiSupported: false,
        devices: [],
        ...gpuOverrides,
      },
      docker: {
        version: "24.0.0",
        composeVersion: "2.20.0",
        socketPath: "/var/run/docker.sock",
      },
      os: { platform: "linux", arch: "x64", version: "6.0" },
      disk: { availableGb: 100, totalGb: 500 },
      operatorId: "test-operator",
    },
  };
}

function makeInput(
  props: GpuTrait,
  overrides?: Partial<TraitTransformInput>,
): TraitTransformInput {
  return {
    app: "myapp",
    // Traits under test read siblings via input.siblingTraits; default to none.
    siblingTraits: [],
    service: "ollama",
    properties: props,
    compose: {
      services: {
        ollama: { image: "ollama/ollama:latest" },
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

describe("gpuTraitDefinition", () => {
  it("has the correct type, scope, and category", () => {
    expect(gpuTraitDefinition.type).toBe("gpu");
    expect(gpuTraitDefinition.scope).toBe("service");
    expect(gpuTraitDefinition.category).toBe("core");
  });
});

describe("gpu transform - nvidia variant", () => {
  it("adds deploy.resources.reservations.devices for nvidia", () => {
    const props: GpuTrait = { type: "gpu", variant: "nvidia", count: 1 };
    const output = gpuTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<
      string,
      Record<string, unknown>
    >;
    const deploy = services.ollama.deploy as Record<string, unknown>;
    const resources = deploy.resources as Record<string, unknown>;
    const reservations = resources.reservations as Record<string, unknown>;
    const devices = reservations.devices as unknown[];

    expect(devices).toHaveLength(1);
    expect(devices[0]).toEqual({
      driver: "nvidia",
      count: 1,
      capabilities: ["gpu"],
    });
  });

  it("uses 'all' when count is -1 for nvidia", () => {
    const props: GpuTrait = { type: "gpu", variant: "nvidia", count: -1 };
    const output = gpuTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<
      string,
      Record<string, unknown>
    >;
    const deploy = services.ollama.deploy as Record<string, unknown>;
    const resources = deploy.resources as Record<string, unknown>;
    const reservations = resources.reservations as Record<string, unknown>;
    const devices = reservations.devices as Array<Record<string, unknown>>;

    expect(devices[0].count).toBe("all");
  });
});

describe("gpu transform - cdi variant", () => {
  it("adds nvidia.com/gpu device entries from runtime facts", () => {
    const props: GpuTrait = { type: "gpu", variant: "cdi", count: 2 };
    const context = makeContext({
      cdiSupported: true,
      devices: ["gpu0", "gpu1", "gpu2"],
    });
    const input = makeInput(props, { context });
    const output = gpuTraitDefinition.transform(input);

    const services = output.compose.services as Record<
      string,
      Record<string, unknown>
    >;
    const devices = services.ollama.devices as string[];

    expect(devices).toEqual([
      "nvidia.com/gpu=gpu0",
      "nvidia.com/gpu=gpu1",
    ]);
  });

  it("uses nvidia.com/gpu=all when no devices are listed", () => {
    const props: GpuTrait = { type: "gpu", variant: "cdi", count: 1 };
    const context = makeContext({ cdiSupported: true, devices: [] });
    const input = makeInput(props, { context });
    const output = gpuTraitDefinition.transform(input);

    const services = output.compose.services as Record<
      string,
      Record<string, unknown>
    >;
    const devices = services.ollama.devices as string[];

    expect(devices).toEqual(["nvidia.com/gpu=all"]);
  });

  it("uses all devices when count is -1", () => {
    const props: GpuTrait = { type: "gpu", variant: "cdi", count: -1 };
    const context = makeContext({
      cdiSupported: true,
      devices: ["gpu0", "gpu1"],
    });
    const input = makeInput(props, { context });
    const output = gpuTraitDefinition.transform(input);

    const services = output.compose.services as Record<
      string,
      Record<string, unknown>
    >;
    const devices = services.ollama.devices as string[];

    expect(devices).toEqual([
      "nvidia.com/gpu=gpu0",
      "nvidia.com/gpu=gpu1",
    ]);
  });
});

describe("gpu transform - rocm variant", () => {
  it("adds /dev/kfd, /dev/dri devices and video/render groups", () => {
    const props: GpuTrait = { type: "gpu", variant: "rocm", count: 1 };
    const context = makeContext({ vendor: "amd" });
    const input = makeInput(props, { context });
    const output = gpuTraitDefinition.transform(input);

    const services = output.compose.services as Record<
      string,
      Record<string, unknown>
    >;
    expect(services.ollama.devices).toEqual(["/dev/kfd", "/dev/dri"]);
    expect(services.ollama.group_add).toEqual(["video", "render"]);
  });
});

describe("gpu transform - auto-detect", () => {
  it("auto-detects nvidia when vendor is nvidia and cdi not supported", () => {
    const props: GpuTrait = { type: "gpu", count: 1 };
    const context = makeContext({
      available: true,
      vendor: "nvidia",
      cdiSupported: false,
    });
    const input = makeInput(props, { context });
    const output = gpuTraitDefinition.transform(input);

    const services = output.compose.services as Record<
      string,
      Record<string, unknown>
    >;
    // Should have deploy.resources (nvidia path)
    expect(services.ollama.deploy).toBeDefined();
    const deploy = services.ollama.deploy as Record<string, unknown>;
    const resources = deploy.resources as Record<string, unknown>;
    expect(resources.reservations).toBeDefined();
  });

  it("auto-detects cdi when cdiSupported is true", () => {
    const props: GpuTrait = { type: "gpu", count: 1 };
    const context = makeContext({
      available: true,
      vendor: "nvidia",
      cdiSupported: true,
      devices: ["gpu0"],
    });
    const input = makeInput(props, { context });
    const output = gpuTraitDefinition.transform(input);

    const services = output.compose.services as Record<
      string,
      Record<string, unknown>
    >;
    const devices = services.ollama.devices as string[];
    expect(devices).toContain("nvidia.com/gpu=gpu0");
  });

  it("auto-detects rocm when vendor is amd", () => {
    const props: GpuTrait = { type: "gpu", count: 1 };
    const context = makeContext({
      available: true,
      vendor: "amd",
      cdiSupported: false,
    });
    const input = makeInput(props, { context });
    const output = gpuTraitDefinition.transform(input);

    const services = output.compose.services as Record<
      string,
      Record<string, unknown>
    >;
    expect(services.ollama.devices).toEqual(["/dev/kfd", "/dev/dri"]);
    expect(services.ollama.group_add).toEqual(["video", "render"]);
  });

  it("throws when gpu is not available and no explicit variant", () => {
    const props: GpuTrait = { type: "gpu", count: 1 };
    const context = makeContext({ available: false, vendor: undefined });
    const input = makeInput(props, { context });

    expect(() => gpuTraitDefinition.transform(input)).toThrow(
      "no GPU detected",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveVariant helper
// ---------------------------------------------------------------------------

describe("resolveVariant", () => {
  const noGpu: GpuFacts = { available: false, cdiSupported: false };
  const nvidiaGpu: GpuFacts = { available: true, vendor: "nvidia", cdiSupported: false };
  const amdGpu: GpuFacts = { available: true, vendor: "amd", cdiSupported: false };
  const cdiGpu: GpuFacts = { available: true, vendor: "nvidia", cdiSupported: true, devices: ["gpu0"] };

  it("returns explicit variant as-is when provided", () => {
    expect(resolveVariant("nvidia", noGpu)).toBe("nvidia");
    expect(resolveVariant("rocm", noGpu)).toBe("rocm");
    expect(resolveVariant("cdi", noGpu)).toBe("cdi");
  });

  it("explicit variant overrides runtime facts", () => {
    // Even if CDI is supported, explicit 'nvidia' takes precedence
    expect(resolveVariant("nvidia", cdiGpu)).toBe("nvidia");
  });

  it("throws when no explicit variant and no GPU available", () => {
    expect(() => resolveVariant(undefined, noGpu)).toThrow("no GPU detected");
  });

  it("returns 'cdi' when CDI is supported (takes priority over vendor)", () => {
    expect(resolveVariant(undefined, cdiGpu)).toBe("cdi");
  });

  it("returns 'nvidia' when vendor is nvidia and CDI not supported", () => {
    expect(resolveVariant(undefined, nvidiaGpu)).toBe("nvidia");
  });

  it("returns 'rocm' when vendor is amd", () => {
    expect(resolveVariant(undefined, amdGpu)).toBe("rocm");
  });

  it("throws for unknown vendor with no explicit variant", () => {
    const unknownGpu: GpuFacts = { available: true, vendor: undefined, cdiSupported: false };
    expect(() => resolveVariant(undefined, unknownGpu)).toThrow("unable to auto-detect");
  });
});

describe("gpu transform - service isolation", () => {
  it("modifies only the target service", () => {
    const props: GpuTrait = { type: "gpu", variant: "nvidia", count: 1 };
    const output = gpuTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<
      string,
      Record<string, unknown>
    >;

    // Target service should have deploy config
    expect(services.ollama.deploy).toBeDefined();

    // Non-target service should remain untouched
    expect(services.web).toEqual({ image: "nginx:latest" });
  });

  it("does not mutate the original compose input", () => {
    const props: GpuTrait = { type: "gpu", variant: "nvidia", count: 1 };
    const input = makeInput(props);
    const originalCompose = structuredClone(input.compose);

    gpuTraitDefinition.transform(input);

    // The original compose object should be unchanged
    expect(input.compose).toEqual(originalCompose);
  });
});
