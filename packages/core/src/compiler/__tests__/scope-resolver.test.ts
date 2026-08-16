import { describe, it, expect } from "vitest";
import { ScopeResolver } from "../scope-resolver.js";
import type { ScopeValues, ScopeError } from "../scope-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ScopeValues with convenient defaults. */
function makeValues(
  overrides: Partial<ScopeValues> = {},
): ScopeValues {
  return {
    project: {},
    environment: {},
    service: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Resolve ${{project.DOMAIN}} from project scope
// ---------------------------------------------------------------------------

describe("ScopeResolver", () => {
  it("resolves ${{project.DOMAIN}} from project scope", () => {
    const resolver = new ScopeResolver(
      makeValues({ project: { DOMAIN: "example.com" } }),
    );

    const result = resolver.resolve("${{project.DOMAIN}}");

    expect(result.resolved).toBe("example.com");
    expect(result.errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2. Service-level var overrides project-level with same key
  // -------------------------------------------------------------------------

  it("service-level var overrides project-level with same key", () => {
    const resolver = new ScopeResolver(
      makeValues({
        project: { PORT: "8080" },
        service: { PORT: "3000" },
      }),
    );

    const result = resolver.resolve("${{service.PORT}}");

    expect(result.resolved).toBe("3000");
    expect(result.errors).toHaveLength(0);

    // Explicitly referencing project scope still returns project value.
    const projectResult = resolver.resolve("${{project.PORT}}");
    expect(projectResult.resolved).toBe("8080");
    expect(projectResult.errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. Full chain: service > environment > project
  // -------------------------------------------------------------------------

  it("respects full scope chain: service > environment > project", () => {
    const resolver = new ScopeResolver(
      makeValues({
        project: { VAR: "from-project" },
        environment: { VAR: "from-environment" },
        service: { VAR: "from-service" },
      }),
    );

    // Each scope reference returns its own value when explicitly named.
    expect(resolver.resolve("${{project.VAR}}").resolved).toBe("from-project");
    expect(resolver.resolve("${{environment.VAR}}").resolved).toBe("from-environment");
    expect(resolver.resolve("${{service.VAR}}").resolved).toBe("from-service");
  });

  // -------------------------------------------------------------------------
  // 5. Undefined var produces ScopeError with key name and scope
  // -------------------------------------------------------------------------

  it("undefined var produces ScopeError with key name and scope", () => {
    const resolver = new ScopeResolver(makeValues());

    const result = resolver.resolve("${{project.MISSING_KEY}}");

    expect(result.resolved).toBe("${{project.MISSING_KEY}}");
    expect(result.errors).toHaveLength(1);

    const err = result.errors[0]!;
    expect(err.reference).toBe("${{project.MISSING_KEY}}");
    expect(err.scope).toBe("project");
    expect(err.key).toBe("MISSING_KEY");
    expect(err.message).toContain("Undefined variable");
    expect(err.message).toContain("MISSING_KEY");
    expect(err.message).toContain("project");
  });

  // -------------------------------------------------------------------------
  // 6. Multiple refs in one string
  // -------------------------------------------------------------------------

  it("resolves multiple refs in one string", () => {
    const resolver = new ScopeResolver(
      makeValues({
        project: { DOMAIN: "example.com" },
        service: { PORT: "8080" },
      }),
    );

    const result = resolver.resolve(
      "https://${{project.DOMAIN}}:${{service.PORT}}",
    );

    expect(result.resolved).toBe("https://example.com:8080");
    expect(result.errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 7. resolveObject handles nested objects and arrays
  // -------------------------------------------------------------------------

  it("resolveObject handles nested objects and arrays", () => {
    const resolver = new ScopeResolver(
      makeValues({
        project: { DOMAIN: "example.com" },
        service: { PORT: "3000" },
      }),
    );

    const input = {
      host: "${{project.DOMAIN}}",
      nested: {
        url: "https://${{project.DOMAIN}}:${{service.PORT}}",
      },
      list: ["${{project.DOMAIN}}", "static-value"],
    };

    const { result, errors } = resolver.resolveObject(input);

    expect(errors).toHaveLength(0);
    expect(result.host).toBe("example.com");
    expect((result.nested as Record<string, unknown>).url).toBe(
      "https://example.com:3000",
    );
    expect(result.list).toEqual(["example.com", "static-value"]);
  });

  // -------------------------------------------------------------------------
  // 8. Regular ${VAR} refs are NOT touched
  // -------------------------------------------------------------------------

  it("does not modify regular ${VAR} docker compose references", () => {
    const resolver = new ScopeResolver(
      makeValues({ project: { DOMAIN: "example.com" } }),
    );

    const result = resolver.resolve(
      "${COMPOSE_VAR} and ${{project.DOMAIN}}",
    );

    expect(result.resolved).toBe("${COMPOSE_VAR} and example.com");
    expect(result.errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 9. Empty template returns unchanged
  // -------------------------------------------------------------------------

  it("empty template returns unchanged", () => {
    const resolver = new ScopeResolver(makeValues());

    const result = resolver.resolve("");

    expect(result.resolved).toBe("");
    expect(result.errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 10. resolveObject passes through non-string values
  // -------------------------------------------------------------------------

  it("resolveObject passes through non-string values (numbers, booleans)", () => {
    const resolver = new ScopeResolver(
      makeValues({ project: { NAME: "myapp" } }),
    );

    const input = {
      name: "${{project.NAME}}",
      port: 8080,
      enabled: true,
      nothing: null,
      count: 0,
    };

    const { result, errors } = resolver.resolveObject(input);

    expect(errors).toHaveLength(0);
    expect(result.name).toBe("myapp");
    expect(result.port).toBe(8080);
    expect(result.enabled).toBe(true);
    expect(result.nothing).toBeNull();
    expect(result.count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // resolve() — invalid scope in template string
  // -------------------------------------------------------------------------

  it("resolve() emits ScopeError for invalid scope name and preserves original ref", () => {
    const resolver = new ScopeResolver(makeValues());

    const result = resolver.resolve("${{invalid.KEY}}");

    expect(result.resolved).toBe("${{invalid.KEY}}");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.scope).toBe("invalid");
    expect(result.errors[0]!.message).toContain("Unknown scope");
  });

  // -------------------------------------------------------------------------
  // resolve() — partial resolution: valid + invalid refs in same string
  // -------------------------------------------------------------------------

  it("resolve() resolves valid refs and accumulates errors for invalid refs in same string", () => {
    const resolver = new ScopeResolver(
      makeValues({ project: { DOMAIN: "example.com" } }),
    );

    // One valid ref + one undefined ref in the same string.
    const result = resolver.resolve("${{project.DOMAIN}} / ${{project.MISSING}}");

    // Valid ref is resolved; missing ref is left in place.
    expect(result.resolved).toBe("example.com / ${{project.MISSING}}");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.key).toBe("MISSING");
  });

  // -------------------------------------------------------------------------
  // resolveObject() — errors from nested values are accumulated
  // -------------------------------------------------------------------------

  it("resolveObject() collects errors from deeply nested and array values", () => {
    const resolver = new ScopeResolver(
      makeValues({ project: { KNOWN: "ok" } }),
    );

    const input = {
      top: "${{project.MISSING_TOP}}",
      nested: { deep: "${{project.MISSING_DEEP}}" },
      list: ["${{project.KNOWN}}", "${{project.MISSING_LIST}}"],
    };

    const { result, errors } = resolver.resolveObject(input);

    // Resolved values: known ref substituted, missing refs kept.
    expect(result.top).toBe("${{project.MISSING_TOP}}");
    expect((result.nested as Record<string, unknown>).deep).toBe("${{project.MISSING_DEEP}}");
    expect(result.list).toEqual(["ok", "${{project.MISSING_LIST}}"]);

    // All three missing refs produced errors.
    expect(errors).toHaveLength(3);
    const keys = errors.map((e) => e.key).sort();
    expect(keys).toEqual(["MISSING_DEEP", "MISSING_LIST", "MISSING_TOP"]);
  });

  // -------------------------------------------------------------------------
  // resolveRef -- single reference resolution
  // -------------------------------------------------------------------------

  describe("resolveRef", () => {
    it("returns the resolved value for a valid reference", () => {
      const resolver = new ScopeResolver(
        makeValues({ project: { DOMAIN: "example.com" } }),
      );

      const result = resolver.resolveRef("${{project.DOMAIN}}");
      expect(result).toBe("example.com");
    });

    it("returns a ScopeError for an undefined key", () => {
      const resolver = new ScopeResolver(makeValues());

      const result = resolver.resolveRef("${{project.NOPE}}");
      expect(typeof result).toBe("object");

      const err = result as ScopeError;
      expect(err.scope).toBe("project");
      expect(err.key).toBe("NOPE");
      expect(err.message).toContain("Undefined variable");
    });

    it("returns a ScopeError for an invalid scope name", () => {
      const resolver = new ScopeResolver(makeValues());

      const result = resolver.resolveRef("${{invalid.KEY}}");
      expect(typeof result).toBe("object");

      const err = result as ScopeError;
      expect(err.scope).toBe("invalid");
      expect(err.message).toContain("Unknown scope");
    });

    it("returns a ScopeError with 'Invalid variable reference format' for malformed refs", () => {
      const resolver = new ScopeResolver(makeValues());

      // These do not match the ${{scope.KEY}} pattern at all.
      for (const bad of ["not-a-ref", "${{no-dot}}", "plain-string", "${{a.b.c}}"]) {
        const result = resolver.resolveRef(bad);
        expect(typeof result).toBe("object");

        const err = result as ScopeError;
        expect(err.scope).toBe("unknown");
        expect(err.key).toBe("unknown");
        expect(err.message).toContain("Invalid variable reference format");
      }
    });
  });
});
