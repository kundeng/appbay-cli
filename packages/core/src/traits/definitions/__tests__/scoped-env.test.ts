import { describe, it, expect } from "vitest";
import { scopedEnvTraitDefinition } from "../scoped-env.js";
import type { TraitTransformInput, CompilerContext } from "../../types.js";
import type { ScopedEnvTrait } from "../../../schemas/appbay-yaml.js";

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
  props: ScopedEnvTrait,
  overrides?: Partial<TraitTransformInput>,
): TraitTransformInput {
  return {
    app: "myapp",
    // Traits under test read siblings via input.siblingTraits; default to none.
    siblingTraits: [],
    service: "web",
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

describe("scopedEnvTraitDefinition", () => {
  it("has the correct type, scope, and category", () => {
    expect(scopedEnvTraitDefinition.type).toBe("scoped-env");
    expect(scopedEnvTraitDefinition.scope).toBe("app");
    expect(scopedEnvTraitDefinition.category).toBe("core");
  });

  it("validates valid scoped-env properties", () => {
    const result = scopedEnvTraitDefinition.schema.safeParse({
      type: "scoped-env",
      vars: { DOMAIN: "example.com" },
    });
    expect(result.success).toBe(true);
  });
});

describe("scoped-env transform", () => {
  it("injects vars into service environment", () => {
    const props: ScopedEnvTrait = {
      type: "scoped-env",
      vars: { DOMAIN: "example.com", APP_PORT: "8080" },
    };
    const input = makeInput(props);
    const output = scopedEnvTraitDefinition.transform(input);

    const svc = (output.compose.services as Record<string, Record<string, unknown>>).web;
    expect(svc.environment).toEqual([
      "DOMAIN=example.com",
      "APP_PORT=8080",
    ]);
  });

  it("appends to existing environment without overwriting", () => {
    const props: ScopedEnvTrait = {
      type: "scoped-env",
      vars: { NEW_VAR: "new-value" },
    };
    const input = makeInput(props, {
      compose: {
        services: {
          web: {
            image: "nginx:latest",
            environment: ["EXISTING=keep-me"],
          },
        },
      },
    });
    const output = scopedEnvTraitDefinition.transform(input);

    const svc = (output.compose.services as Record<string, Record<string, unknown>>).web;
    expect(svc.environment).toEqual([
      "EXISTING=keep-me",
      "NEW_VAR=new-value",
    ]);
  });

  it("preserves ${{scope.KEY}} references for later resolution", () => {
    const props: ScopedEnvTrait = {
      type: "scoped-env",
      vars: {
        DOMAIN: "${{project.DOMAIN}}",
        DB_HOST: "${{environment.DB_HOST}}",
      },
    };
    const input = makeInput(props);
    const output = scopedEnvTraitDefinition.transform(input);

    const svc = (output.compose.services as Record<string, Record<string, unknown>>).web;
    expect(svc.environment).toEqual([
      "DOMAIN=${{project.DOMAIN}}",
      "DB_HOST=${{environment.DB_HOST}}",
    ]);
  });

  it("passes static values through unchanged", () => {
    const props: ScopedEnvTrait = {
      type: "scoped-env",
      vars: { APP_PORT: "8080", DEBUG: "false" },
    };
    const input = makeInput(props);
    const output = scopedEnvTraitDefinition.transform(input);

    const svc = (output.compose.services as Record<string, Record<string, unknown>>).web;
    expect(svc.environment).toContain("APP_PORT=8080");
    expect(svc.environment).toContain("DEBUG=false");
  });

  it("does not modify compose when target service does not exist", () => {
    const props: ScopedEnvTrait = {
      type: "scoped-env",
      vars: { DOMAIN: "example.com" },
    };
    const input = makeInput(props, { service: "nonexistent" });
    const output = scopedEnvTraitDefinition.transform(input);

    // Compose should be structurally equal to the original (deep clone, no mutation)
    const svc = (output.compose.services as Record<string, Record<string, unknown>>).web;
    expect(svc.environment).toBeUndefined();
  });

  it("produces no change when vars record is empty", () => {
    const props: ScopedEnvTrait = {
      type: "scoped-env",
      vars: {},
    };
    const input = makeInput(props);
    const output = scopedEnvTraitDefinition.transform(input);

    const svc = (output.compose.services as Record<string, Record<string, unknown>>).web;
    // Empty vars means an empty array is set (appended to no existing env)
    expect(svc.environment).toEqual([]);
  });

  it("skips environment injection when service is undefined", () => {
    // Covers the `!targetService` falsy branch — distinct from `service: 'nonexistent'`
    // which exercises the `!services[targetService]` path.
    const props: ScopedEnvTrait = {
      type: "scoped-env",
      vars: { DOMAIN: "example.com" },
    };
    const input = makeInput(props, { service: undefined });
    const output = scopedEnvTraitDefinition.transform(input);

    // Compose is unchanged — no environment added to any service.
    const svc = (output.compose.services as Record<string, Record<string, unknown>>).web;
    expect(svc.environment).toBeUndefined();
  });

  it("treats object-form environment as empty array (does not merge)", () => {
    // When environment is a dict { KEY: "val" } rather than an array, the guard
    // `Array.isArray(svc.environment) ? svc.environment : []` yields [].
    // New vars are appended to [] — the original object-form entries are not included.
    const props: ScopedEnvTrait = {
      type: "scoped-env",
      vars: { NEW_VAR: "new-value" },
    };
    const input = makeInput(props, {
      compose: {
        services: {
          web: {
            image: "nginx:latest",
            environment: { EXISTING: "old-value" } as unknown as string[],
          },
        },
      },
    });
    const output = scopedEnvTraitDefinition.transform(input);

    const svc = (output.compose.services as Record<string, Record<string, unknown>>).web;
    // Only the newly injected var appears; object-form env is not merged.
    expect(svc.environment).toEqual(["NEW_VAR=new-value"]);
  });
});
