import { describe, it, expect } from "vitest";
import {
  ProjectConfigSchema,
  EnvironmentConfigSchema,
} from "../project.js";

// ---------------------------------------------------------------------------
// ProjectConfigSchema
// ---------------------------------------------------------------------------

describe("ProjectConfigSchema", () => {
  it("parses a project config with vars and defaults", () => {
    const result = ProjectConfigSchema.parse({
      name: "homelab",
      vars: {
        DOMAIN: "example.com",
        TZ: "America/New_York",
      },
      defaults: {
        environment: "prod",
        operator: "node-1",
        secret_provider: "vault",
      },
    });

    expect(result.name).toBe("homelab");
    expect(result.vars).toEqual({
      DOMAIN: "example.com",
      TZ: "America/New_York",
    });
    expect(result.defaults?.environment).toBe("prod");
    expect(result.defaults?.operator).toBe("node-1");
    expect(result.defaults?.secret_provider).toBe("vault");
  });

  it("parses a minimal project config with only name", () => {
    const result = ProjectConfigSchema.parse({ name: "minimal" });

    expect(result.name).toBe("minimal");
    expect(result.vars).toBeUndefined();
    expect(result.defaults).toBeUndefined();
  });

  it("rejects a project config missing the required name field", () => {
    const result = ProjectConfigSchema.safeParse({
      vars: { DOMAIN: "example.com" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("name");
    }
  });

  it("applies partial defaults when only some defaults are set", () => {
    const result = ProjectConfigSchema.parse({
      name: "partial",
      defaults: { environment: "staging" },
    });

    expect(result.defaults?.environment).toBe("staging");
    expect(result.defaults?.operator).toBeUndefined();
    expect(result.defaults?.secret_provider).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EnvironmentConfigSchema
// ---------------------------------------------------------------------------

describe("EnvironmentConfigSchema", () => {
  it("parses an environment config with vars and overrides", () => {
    const result = EnvironmentConfigSchema.parse({
      name: "prod",
      vars: {
        LOG_LEVEL: "warn",
        REPLICAS: "3",
      },
      overrides: {
        DOMAIN: "prod.example.com",
      },
    });

    expect(result.name).toBe("prod");
    expect(result.vars?.LOG_LEVEL).toBe("warn");
    expect(result.overrides?.DOMAIN).toBe("prod.example.com");
  });

  it("parses a minimal environment config with only name", () => {
    const result = EnvironmentConfigSchema.parse({ name: "dev" });

    expect(result.name).toBe("dev");
    expect(result.vars).toBeUndefined();
    expect(result.overrides).toBeUndefined();
  });

  it("rejects an environment config missing the required name field", () => {
    const result = EnvironmentConfigSchema.safeParse({
      vars: { LOG_LEVEL: "debug" },
    });

    expect(result.success).toBe(false);
  });
});
