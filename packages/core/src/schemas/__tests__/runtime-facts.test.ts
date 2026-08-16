import { describe, it, expect } from "vitest";
import { RuntimeFactsSchema, GpuVendorSchema } from "../runtime-facts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A complete, valid RuntimeFacts object for use as a baseline in tests. */
function fullFacts() {
  return {
    gpu: {
      available: true,
      vendor: "nvidia" as const,
      cdiSupported: true,
      devices: ["nvidia.com/gpu=0", "nvidia.com/gpu=1"],
    },
    docker: {
      version: "24.0.7",
      composeVersion: "2.23.3",
      socketPath: "/var/run/docker.sock",
    },
    os: {
      platform: "linux",
      arch: "x64",
      version: "6.5.0-35-generic",
    },
    disk: {
      availableGb: 250,
      totalGb: 500,
    },
    operatorId: "node-1",
  };
}

// ---------------------------------------------------------------------------
// 1. Valid full facts object
// ---------------------------------------------------------------------------

describe("valid full RuntimeFacts", () => {
  it("parses a complete facts object with all fields populated", () => {
    const input = fullFacts();
    const result = RuntimeFactsSchema.parse(input);

    expect(result.gpu.available).toBe(true);
    expect(result.gpu.vendor).toBe("nvidia");
    expect(result.gpu.cdiSupported).toBe(true);
    expect(result.gpu.devices).toEqual(["nvidia.com/gpu=0", "nvidia.com/gpu=1"]);
    expect(result.docker.version).toBe("24.0.7");
    expect(result.docker.composeVersion).toBe("2.23.3");
    expect(result.docker.socketPath).toBe("/var/run/docker.sock");
    expect(result.os.platform).toBe("linux");
    expect(result.os.arch).toBe("x64");
    expect(result.os.version).toBe("6.5.0-35-generic");
    expect(result.disk.availableGb).toBe(250);
    expect(result.disk.totalGb).toBe(500);
    expect(result.operatorId).toBe("node-1");
  });
});

// ---------------------------------------------------------------------------
// 2. Minimal facts (just operatorId + docker)
// ---------------------------------------------------------------------------

describe("minimal RuntimeFacts", () => {
  it("parses with gpu.available=false and no vendor/devices", () => {
    const input = {
      gpu: { available: false },
      docker: {
        version: "25.0.0",
        composeVersion: "2.24.0",
        socketPath: "/var/run/docker.sock",
      },
      os: {
        platform: "linux",
        arch: "arm64",
        version: "6.1.0",
      },
      disk: {
        availableGb: 100,
        totalGb: 200,
      },
      operatorId: "op-minimal",
    };

    const result = RuntimeFactsSchema.parse(input);

    expect(result.gpu.available).toBe(false);
    expect(result.gpu.vendor).toBeUndefined();
    expect(result.gpu.cdiSupported).toBe(false); // default
    expect(result.gpu.devices).toBeUndefined();
    expect(result.operatorId).toBe("op-minimal");
  });
});

// ---------------------------------------------------------------------------
// 3. Invalid GPU vendor rejected
// ---------------------------------------------------------------------------

describe("invalid GPU vendor", () => {
  it("rejects an unrecognized GPU vendor string", () => {
    const input = fullFacts();
    (input.gpu as Record<string, unknown>).vendor = "qualcomm";

    const result = RuntimeFactsSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("gpu"))).toBe(true);
    }
  });

  it("rejects invalid vendor via GpuVendorSchema directly", () => {
    const result = GpuVendorSchema.safeParse("arm");
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Missing required docker version rejected
// ---------------------------------------------------------------------------

describe("missing required docker fields", () => {
  it("rejects facts with docker.version missing", () => {
    const input = fullFacts();
    delete (input.docker as Record<string, unknown>).version;

    const result = RuntimeFactsSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("docker"))).toBe(true);
    }
  });

  it("rejects facts with docker section entirely missing", () => {
    const { docker: _, ...rest } = fullFacts();
    const result = RuntimeFactsSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. GPU not available -- no vendor/devices required
// ---------------------------------------------------------------------------

describe("GPU not available", () => {
  it("accepts gpu.available=false without vendor or devices", () => {
    const input = {
      gpu: { available: false },
      docker: {
        version: "24.0.7",
        composeVersion: "2.23.3",
        socketPath: "/var/run/docker.sock",
      },
      os: {
        platform: "darwin",
        arch: "arm64",
        version: "14.3.1",
      },
      disk: {
        availableGb: 50,
        totalGb: 500,
      },
      operatorId: "mac-mini",
    };

    const result = RuntimeFactsSchema.parse(input);
    expect(result.gpu.available).toBe(false);
    expect(result.gpu.vendor).toBeUndefined();
    expect(result.gpu.devices).toBeUndefined();
    expect(result.gpu.cdiSupported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. cdiSupported defaults to false
// ---------------------------------------------------------------------------

describe("defaults", () => {
  it("defaults cdiSupported to false when not provided", () => {
    const input = fullFacts();
    delete (input.gpu as Record<string, unknown>).cdiSupported;

    const result = RuntimeFactsSchema.parse(input);
    expect(result.gpu.cdiSupported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Missing operatorId rejected
// ---------------------------------------------------------------------------

describe("missing operatorId", () => {
  it("rejects facts without operatorId", () => {
    const { operatorId: _, ...rest } = fullFacts();
    const result = RuntimeFactsSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. All valid GPU vendors accepted
// ---------------------------------------------------------------------------

describe("all GPU vendors", () => {
  it.each(["nvidia", "amd", "intel", "none"] as const)(
    "accepts vendor '%s'",
    (vendor) => {
      const input = fullFacts();
      (input.gpu as Record<string, unknown>).vendor = vendor;
      const result = RuntimeFactsSchema.safeParse(input);
      expect(result.success).toBe(true);
    },
  );
});
