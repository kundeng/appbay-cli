/**
 * One value scope, `${{ns:KEY}}`. The pre-S43 dotted `${{project.KEY}}` resolves for one
 * release with a warning; every other spelling is an error naming the one scope.
 */
import { describe, it, expect } from "vitest";
import { ScopeResolver } from "../scope-resolver.js";

const resolver = new ScopeResolver({ ns: { DOMAIN: "example.org", TIER: "sim" } });

describe("ScopeResolver", () => {
  it("resolves ${{ns:KEY}} and its namespace: alias", () => {
    expect(resolver.resolve("a.${{ns:DOMAIN}}").resolved).toBe("a.example.org");
    expect(resolver.resolve("${{namespace:TIER}}").resolved).toBe("sim");
  });

  it("resolves several references in one string", () => {
    const r = resolver.resolve("${{ns:TIER}}-x.${{ns:DOMAIN}}");
    expect(r.resolved).toBe("sim-x.example.org");
    expect(r.errors).toEqual([]);
  });

  it("accepts the dotted project spelling for one release, warning once per reference", () => {
    const r = resolver.resolve("a.${{project.DOMAIN}}");
    expect(r.resolved).toBe("a.example.org");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("${{ns:DOMAIN}}");
  });

  it("rejects other scope names and a dotted ns, naming the one scope", () => {
    for (const ref of ["${{app:NAME}}", "${{service:X}}", "${{environment:X}}", "${{ns.DOMAIN}}"]) {
      const r = resolver.resolve(ref);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.message).toContain("ns:");
      expect(r.resolved).toBe(ref);
    }
  });

  it("reports an undefined key with its scope", () => {
    const r = resolver.resolve("${{ns:NOPE}}");
    expect(r.errors[0]!.message).toContain('"NOPE" in scope "ns"');
  });

  it("leaves plain Compose ${VAR} alone", () => {
    expect(resolver.resolve("${VAR} and $OTHER").resolved).toBe("${VAR} and $OTHER");
  });

  it("resolveRef answers a single reference or an error", () => {
    expect(resolver.resolveRef("${{ns:TIER}}")).toBe("sim");
    expect(resolver.resolveRef("${{bogus:X}}")).toMatchObject({ scope: "bogus" });
  });
});
