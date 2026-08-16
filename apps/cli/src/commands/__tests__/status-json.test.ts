/**
 * Unit tests for status command JSON-building utilities.
 *
 * `appDetailToJson` and `appSummaryToJson` are pure transform functions
 * that convert a DiscoveredApp into a plain JSON-serializable record.
 * No filesystem access, no mocks, no side effects.
 *
 * Coverage:
 *
 * appDetailToJson:
 *   - name, dir, composeFile (basename), hasAppbayYaml
 *   - project / environment default to "default" when appbayConfig is null
 *   - project / environment read from appbayConfig when present
 *   - services: empty when no services in composeContent
 *   - services: sorted list of service names from composeContent
 *   - traits: [] when appbayConfig is null
 *   - traits: type strings from appbayConfig.traits
 *   - overlays: [] when appbayConfig is null
 *   - overlays: {when, services[]} per overlay entry
 *   - upstream: null when not configured
 *   - upstream: passed through from appbayConfig.upstream
 *   - errors: mapped to {file, message} objects (details stripped)
 *   - errors: [] when no errors
 *   - output keys exactly match expected shape
 *
 * appSummaryToJson:
 *   - name, project, environment, hasAppbayYaml (same logic as detail)
 *   - services: count (number), not names
 *   - traits: count (number), not type strings
 *   - errors: count (number), not error objects
 *   - output keys exactly match expected shape
 */

import { describe, it, expect } from "vitest";
import { appDetailToJson, appSummaryToJson } from "../status.js";
import type { DiscoveredApp } from "@appbay/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(overrides: Partial<DiscoveredApp> = {}): DiscoveredApp {
  return {
    name: "myapp",
    dir: "/srv/appbay/etc/apps/myapp",
    composePath: "/srv/appbay/etc/apps/myapp/docker-compose.yml",
    composeContent: {},
    appbayConfig: null,
    errors: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// appDetailToJson
// ---------------------------------------------------------------------------

describe("appDetailToJson", () => {
  // ── Identity fields ───────────────────────────────────────────────────────

  it("copies name verbatim", () => {
    expect(appDetailToJson(makeApp({ name: "blog" })).name).toBe("blog");
  });

  it("copies dir verbatim", () => {
    const dir = "/data/apps/blog";
    expect(appDetailToJson(makeApp({ dir })).dir).toBe(dir);
  });

  it("uses basename of composePath as composeFile", () => {
    const result = appDetailToJson(
      makeApp({ composePath: "/data/apps/blog/docker-compose.yml" }),
    );
    expect(result.composeFile).toBe("docker-compose.yml");
  });

  it("uses basename for non-standard compose filenames", () => {
    const result = appDetailToJson(
      makeApp({ composePath: "/data/apps/blog/compose.yaml" }),
    );
    expect(result.composeFile).toBe("compose.yaml");
  });

  // ── appbayConfig null ─────────────────────────────────────────────────────

  it("project defaults to 'default' when appbayConfig is null", () => {
    expect(appDetailToJson(makeApp()).project).toBe("default");
  });

  it("environment defaults to 'default' when appbayConfig is null", () => {
    expect(appDetailToJson(makeApp()).environment).toBe("default");
  });

  it("hasAppbayYaml is false when appbayConfig is null", () => {
    expect(appDetailToJson(makeApp()).hasAppbayYaml).toBe(false);
  });

  it("traits is [] when appbayConfig is null", () => {
    expect(appDetailToJson(makeApp()).traits).toEqual([]);
  });

  it("overlays is [] when appbayConfig is null", () => {
    expect(appDetailToJson(makeApp()).overlays).toEqual([]);
  });

  it("upstream is null when appbayConfig is null", () => {
    expect(appDetailToJson(makeApp()).upstream).toBeNull();
  });

  // ── appbayConfig present ──────────────────────────────────────────────────

  it("reads project from appbayConfig", () => {
    const result = appDetailToJson(
      makeApp({ appbayConfig: { project: "acme", environment: "prod" } as never }),
    );
    expect(result.project).toBe("acme");
  });

  it("reads environment from appbayConfig", () => {
    const result = appDetailToJson(
      makeApp({ appbayConfig: { project: "acme", environment: "prod" } as never }),
    );
    expect(result.environment).toBe("prod");
  });

  it("hasAppbayYaml is true when appbayConfig is non-null", () => {
    const result = appDetailToJson(
      makeApp({ appbayConfig: {} as never }),
    );
    expect(result.hasAppbayYaml).toBe(true);
  });

  it("project defaults to 'default' when appbayConfig.project is absent", () => {
    const result = appDetailToJson(
      makeApp({ appbayConfig: { environment: "staging" } as never }),
    );
    expect(result.project).toBe("default");
  });

  // ── Services ──────────────────────────────────────────────────────────────

  it("services is [] when composeContent has no services key", () => {
    expect(appDetailToJson(makeApp()).services).toEqual([]);
  });

  it("services is sorted list of service names from composeContent", () => {
    const result = appDetailToJson(
      makeApp({ composeContent: { services: { web: {}, db: {}, cache: {} } } }),
    );
    expect(result.services).toEqual(["cache", "db", "web"]);
  });

  it("services is [] when composeContent.services is empty object", () => {
    const result = appDetailToJson(
      makeApp({ composeContent: { services: {} } }),
    );
    expect(result.services).toEqual([]);
  });

  // ── Traits ────────────────────────────────────────────────────────────────

  it("traits returns type strings from appbayConfig.traits", () => {
    const result = appDetailToJson(
      makeApp({
        appbayConfig: {
          traits: [{ type: "ingress" }, { type: "gpu" }],
        } as never,
      }),
    );
    expect(result.traits).toEqual(["ingress", "gpu"]);
  });

  it("traits is [] when appbayConfig.traits is empty array", () => {
    const result = appDetailToJson(
      makeApp({ appbayConfig: { traits: [] } as never }),
    );
    expect(result.traits).toEqual([]);
  });

  // ── Overlays ──────────────────────────────────────────────────────────────

  it("overlays maps each entry to {when, services[]}", () => {
    const result = appDetailToJson(
      makeApp({
        appbayConfig: {
          overlays: [
            {
              when: ["gpu"],
              services: { web: { image: "nginx" }, db: { image: "postgres" } },
            },
          ],
        } as never,
      }),
    );
    expect(result.overlays).toEqual([
      { when: ["gpu"], services: expect.arrayContaining(["web", "db"]) },
    ]);
  });

  it("overlays is [] when appbayConfig.overlays is empty array", () => {
    const result = appDetailToJson(
      makeApp({ appbayConfig: { overlays: [] } as never }),
    );
    expect(result.overlays).toEqual([]);
  });

  // ── Upstream ──────────────────────────────────────────────────────────────

  it("upstream is passed through from appbayConfig.upstream", () => {
    const upstream = { source: "repo://org/app" };
    const result = appDetailToJson(
      makeApp({ appbayConfig: { upstream } as never }),
    );
    expect(result.upstream).toEqual(upstream);
  });

  it("upstream is null when appbayConfig has no upstream key", () => {
    const result = appDetailToJson(
      makeApp({ appbayConfig: {} as never }),
    );
    expect(result.upstream).toBeNull();
  });

  // ── Errors ────────────────────────────────────────────────────────────────

  it("errors is [] when no errors", () => {
    expect(appDetailToJson(makeApp()).errors).toEqual([]);
  });

  it("errors maps to {file, message} objects", () => {
    const result = appDetailToJson(
      makeApp({
        errors: [
          { file: "/etc/apps/foo/appbay.yaml", message: "parse error", details: { extra: true } },
        ],
      }),
    );
    expect(result.errors).toEqual([
      { file: "/etc/apps/foo/appbay.yaml", message: "parse error" },
    ]);
  });

  it("errors strips details (not included in output)", () => {
    const result = appDetailToJson(
      makeApp({
        errors: [{ file: "f.yaml", message: "bad", details: { issues: [] } }],
      }),
    );
    const errObj = (result.errors as Array<Record<string, unknown>>)[0];
    expect(errObj).not.toHaveProperty("details");
  });

  it("errors reflects multiple error entries", () => {
    const result = appDetailToJson(
      makeApp({
        errors: [
          { file: "a.yaml", message: "err1" },
          { file: "b.yaml", message: "err2" },
        ],
      }),
    );
    expect((result.errors as unknown[]).length).toBe(2);
  });

  // ── Output shape ──────────────────────────────────────────────────────────

  it("output keys match the expected detail shape", () => {
    const keys = Object.keys(appDetailToJson(makeApp())).sort();
    expect(keys).toEqual([
      "composeFile", "dir", "environment", "errors", "hasAppbayYaml",
      "name", "overlays", "project", "services", "traits", "upstream",
    ]);
  });
});

// ---------------------------------------------------------------------------
// appSummaryToJson
// ---------------------------------------------------------------------------

describe("appSummaryToJson", () => {
  // ── Identity fields ───────────────────────────────────────────────────────

  it("copies name verbatim", () => {
    expect(appSummaryToJson(makeApp({ name: "wiki" })).name).toBe("wiki");
  });

  it("project defaults to 'default' when appbayConfig is null", () => {
    expect(appSummaryToJson(makeApp()).project).toBe("default");
  });

  it("environment defaults to 'default' when appbayConfig is null", () => {
    expect(appSummaryToJson(makeApp()).environment).toBe("default");
  });

  it("hasAppbayYaml is false when appbayConfig is null", () => {
    expect(appSummaryToJson(makeApp()).hasAppbayYaml).toBe(false);
  });

  it("hasAppbayYaml is true when appbayConfig is non-null", () => {
    expect(
      appSummaryToJson(makeApp({ appbayConfig: {} as never })).hasAppbayYaml,
    ).toBe(true);
  });

  // ── Counts (not arrays) ───────────────────────────────────────────────────

  it("services is 0 when composeContent has no services", () => {
    expect(appSummaryToJson(makeApp()).services).toBe(0);
  });

  it("services is the count of services in composeContent", () => {
    const result = appSummaryToJson(
      makeApp({ composeContent: { services: { a: {}, b: {}, c: {} } } }),
    );
    expect(result.services).toBe(3);
  });

  it("services is a number, not an array", () => {
    expect(typeof appSummaryToJson(makeApp()).services).toBe("number");
  });

  it("traits is 0 when appbayConfig is null", () => {
    expect(appSummaryToJson(makeApp()).traits).toBe(0);
  });

  it("traits is the count of traits in appbayConfig.traits", () => {
    const result = appSummaryToJson(
      makeApp({
        appbayConfig: { traits: [{ type: "ingress" }, { type: "auth" }] } as never,
      }),
    );
    expect(result.traits).toBe(2);
  });

  it("traits is a number, not an array", () => {
    expect(typeof appSummaryToJson(makeApp()).traits).toBe("number");
  });

  it("errors is 0 when no errors", () => {
    expect(appSummaryToJson(makeApp()).errors).toBe(0);
  });

  it("errors is the count of error entries", () => {
    const result = appSummaryToJson(
      makeApp({ errors: [{ file: "f", message: "m" }, { file: "g", message: "n" }] }),
    );
    expect(result.errors).toBe(2);
  });

  it("errors is a number, not an array", () => {
    expect(typeof appSummaryToJson(makeApp()).errors).toBe("number");
  });

  // ── Output shape ──────────────────────────────────────────────────────────

  it("output keys match the expected summary shape", () => {
    const keys = Object.keys(appSummaryToJson(makeApp())).sort();
    expect(keys).toEqual([
      "environment", "errors", "hasAppbayYaml", "name", "project", "services", "traits",
    ]);
  });

  // ── summary has fewer keys than detail ────────────────────────────────────

  it("summary does not include 'dir', 'composeFile', 'overlays', 'upstream'", () => {
    const keys = Object.keys(appSummaryToJson(makeApp()));
    expect(keys).not.toContain("dir");
    expect(keys).not.toContain("composeFile");
    expect(keys).not.toContain("overlays");
    expect(keys).not.toContain("upstream");
  });
});
