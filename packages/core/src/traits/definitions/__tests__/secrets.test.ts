import { describe, it, expect } from "vitest";
import { secretsTraitDefinition } from "../secrets.js";
import type { TraitTransformInput, CompilerContext } from "../../types.js";
import type { SecretsTrait } from "../../../schemas/appbay-yaml.js";

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
  props: SecretsTrait,
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

describe("secretsTraitDefinition", () => {
  it("has the correct type, scope, and category", () => {
    expect(secretsTraitDefinition.type).toBe("secrets");
    expect(secretsTraitDefinition.scope).toBe("service");
    expect(secretsTraitDefinition.category).toBe("core");
  });

  it("validates valid secrets properties", () => {
    const result = secretsTraitDefinition.schema.safeParse({
      type: "secrets",
      refs: { DB_PASSWORD: "vault://project/prod/db/password" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects secrets properties missing required refs", () => {
    const result = secretsTraitDefinition.schema.safeParse({
      type: "secrets",
    });
    expect(result.success).toBe(false);
  });
});

describe("secrets transform", () => {
  it("adds ${KEY} interpolation entries when no environment block exists", () => {
    const props: SecretsTrait = {
      type: "secrets",
      provider: "vault",
      refs: {
        DB_PASSWORD: "vault://project/prod/db/password",
        API_KEY: "env://API_KEY",
      },
      injection: "runtime-env",
    };
    const input = makeInput(props);
    const output = secretsTraitDefinition.transform(input);

    const svc = (output.compose.services as Record<string, Record<string, unknown>>).web;
    const env = svc.environment as Record<string, string>;
    expect(env.DB_PASSWORD).toBe("${DB_PASSWORD}");
    expect(env.API_KEY).toBe("${API_KEY}");
    expect(svc.image).toBe("nginx:latest");
  });

  it("preserves existing environment and appends missing ref keys", () => {
    const props: SecretsTrait = {
      type: "secrets",
      provider: "vault",
      refs: { SECRET_VAR: "file:///run/secrets/token" },
      injection: "runtime-env",
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
    const output = secretsTraitDefinition.transform(input);

    const svc = (output.compose.services as Record<string, Record<string, unknown>>).web;
    expect(svc.environment).toEqual(["EXISTING=keep-me", "SECRET_VAR=${SECRET_VAR}"]);
  });

  it("returns metadata with secret ref details including provider and injection", () => {
    const props: SecretsTrait = {
      type: "secrets",
      provider: "vault",
      refs: {
        DB_PASSWORD: "vault://project/prod/db/password",
        API_KEY: "env://API_KEY",
      },
      injection: "runtime-env",
    };
    const input = makeInput(props);
    const output = secretsTraitDefinition.transform(input);

    expect(output.metadata).toBeDefined();
    expect(output.metadata!.secretRefs).toEqual([
      { key: "DB_PASSWORD", uri: "vault://project/prod/db/password", provider: "vault", injection: "runtime-env", optional: false, app: "myapp", service: "web" },
      { key: "API_KEY", uri: "env://API_KEY", provider: "vault", injection: "runtime-env", optional: false, app: "myapp", service: "web" },
    ]);
  });

  it("does not modify compose when target service does not exist", () => {
    const props: SecretsTrait = {
      type: "secrets",
      provider: "vault",
      refs: { DB_PASSWORD: "vault://project/prod/db/password" },
      injection: "runtime-env",
    };
    const input = makeInput(props, { service: "nonexistent" });
    const output = secretsTraitDefinition.transform(input);

    const svc = (output.compose.services as Record<string, Record<string, unknown>>).web;
    expect(svc.environment).toBeUndefined();
    // Metadata is still produced even when the service is not found
    expect(output.metadata!.secretRefs).toHaveLength(1);
  });

  it("appends missing ref keys when secret keys not already in env", () => {
    const originalCompose = {
      services: {
        web: { image: "nginx:latest", environment: ["EXISTING=value"] },
      },
    };
    const props: SecretsTrait = {
      type: "secrets",
      provider: "vault",
      refs: { NEW_SECRET: "env://NEW_SECRET" },
      injection: "runtime-env",
    };
    const input = makeInput(props, { compose: originalCompose });
    const output = secretsTraitDefinition.transform(input);

    const svc = (output.compose.services as Record<string, Record<string, unknown>>).web;
    expect(svc.environment).toEqual(["EXISTING=value", "NEW_SECRET=${NEW_SECRET}"]);
  });

  it("replaces matching env var values with ${KEY} references for runtime-env injection", () => {
    const originalCompose = {
      services: {
        web: {
          image: "nginx:latest",
          environment: { DB_PASSWORD: "placeholder", OTHER: "keep" },
        },
      },
    };
    const props: SecretsTrait = {
      type: "secrets",
      provider: "vault",
      refs: { DB_PASSWORD: "vault://proj/dev/DB_PASSWORD" },
      injection: "runtime-env",
    };
    const input = makeInput(props, { compose: originalCompose, service: "web" });
    const output = secretsTraitDefinition.transform(input);

    const svc = (output.compose.services as Record<string, Record<string, unknown>>).web;
    const env = svc.environment as Record<string, string>;
    // DB_PASSWORD replaced with ${DB_PASSWORD} so docker compose resolves from process env
    expect(env.DB_PASSWORD).toBe("${DB_PASSWORD}");
    // OTHER untouched
    expect(env.OTHER).toBe("keep");
  });

  it("replaces array-style environment entries with ${KEY} references", () => {
    const originalCompose = {
      services: {
        db: {
          image: "postgres:16",
          environment: ["POSTGRES_PASSWORD=changeme", "POSTGRES_DB=myapp"],
        },
      },
    };
    const props: SecretsTrait = {
      type: "secrets",
      provider: "vault",
      refs: { POSTGRES_PASSWORD: "vault://myapp/POSTGRES_PASSWORD" },
      injection: "runtime-env",
    };
    const input = makeInput(props, { compose: originalCompose, service: "db" });
    const output = secretsTraitDefinition.transform(input);

    const svc = (output.compose.services as Record<string, Record<string, unknown>>).db;
    const env = svc.environment as string[];
    expect(env[0]).toBe("POSTGRES_PASSWORD=${POSTGRES_PASSWORD}");
    expect(env[1]).toBe("POSTGRES_DB=myapp");
  });

  it("repoints a mismatched ${OTHER} reference at the key appbay actually injects", () => {
    const originalCompose = {
      services: {
        app: {
          image: "app:latest",
          environment: { DB_PASS: "${KESTRA_DB_PASS}", API_KEY: "hardcoded" },
        },
      },
    };
    const props: SecretsTrait = {
      type: "secrets",
      provider: "vault",
      refs: {
        DB_PASS: "vault://app/DB_PASS",
        API_KEY: "vault://app/API_KEY",
      },
      injection: "runtime-env",
    };
    const input = makeInput(props, { compose: originalCompose, service: "app" });
    const output = secretsTraitDefinition.transform(input);

    const svc = (output.compose.services as Record<string, Record<string, unknown>>).app;
    const env = svc.environment as Record<string, string>;

    // ⚠️ ASSERTION REVERSED 2026-08-07, and the test renamed with it. This asserted that a
    // value which is ALREADY a ${VAR} reference is left alone, so `${KESTRA_DB_PASS}`
    // survived untouched. c78ed1a ("secrets trait handles both env var key and variable
    // reference targeting", 2026-05-29) deliberately changed that to always rewrite when the
    // refs key matches the env var KEY — three weeks after this test was written, and the
    // test was never updated, so it had been red ever since.
    //
    // The newer behaviour is also the correct one. `refs` declares DB_PASS, so appbay injects
    // DB_PASS into the process env at deploy time and injects nothing called
    // KESTRA_DB_PASS. Leaving the old reference in place would resolve to an unset variable
    // — an empty password reaching the container, which fails at runtime as a connection
    // error rather than anywhere near the secrets config that caused it. Repointing it at
    // the name that is actually injected is what makes the wiring work.
    expect(env.DB_PASS).toBe("${DB_PASS}");
    // Hardcoded — replace
    expect(env.API_KEY).toBe("${API_KEY}");
  });
});
