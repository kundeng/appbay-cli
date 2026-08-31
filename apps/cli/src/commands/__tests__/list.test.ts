/**
 * Unit tests for list command utilities.
 *
 * `appToJson` converts a DiscoveredApp into a plain JSON-serializable record.
 * The function is pure — it only reads from the app object with no side effects.
 *
 * Coverage:
 *   - name is copied verbatim
 *   - dir is copied verbatim
 *   - composeFile is the basename of composePath (not the full path)
 *   - errors is the count (number), not the error array itself
 *   - namespace falls back to "default" when appbayConfig is null
 *   - hasAppbayYaml is false when appbayConfig is null
 *   - namespace is read from appbayConfig.namespace when present
 *   - hasAppbayYaml is true when appbayConfig is non-null
 *   - namespace falls back to "default" when appbayConfig.namespace is undefined
 *   - errors count reflects the length of the errors array
 *   - output object has exactly the expected keys (no extras)
 */

import { describe, it, expect } from "vitest";
import { appToJson } from "../list.js";
import type { DiscoveredApp } from "@appbay/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal DiscoveredApp with no appbay.yaml and no errors. */
function makeApp(overrides: Partial<DiscoveredApp> = {}): DiscoveredApp {
  return {
    name: "myapp",
    dir: "/home/user/.appbay/etc/apps/myapp",
    composePath: "/home/user/.appbay/etc/apps/myapp/docker-compose.yml",
    composeContent: {},
    appbayConfig: null,
    errors: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// appToJson
// ---------------------------------------------------------------------------

describe("appToJson", () => {
  // ── Name and directory ────────────────────────────────────────────────────

  it("copies the app name verbatim", () => {
    const result = appToJson(makeApp({ name: "wordpress" }));
    expect(result.name).toBe("wordpress");
  });

  it("copies the app dir verbatim", () => {
    const dir = "/srv/appbay/etc/apps/blog";
    const result = appToJson(makeApp({ dir }));
    expect(result.dir).toBe(dir);
  });

  // ── Compose file path → basename ──────────────────────────────────────────

  it("uses the basename of composePath as composeFile", () => {
    const result = appToJson(
      makeApp({ composePath: "/etc/apps/myapp/docker-compose.yml" }),
    );
    expect(result.composeFile).toBe("docker-compose.yml");
  });

  it("uses the basename even for non-standard filenames", () => {
    const result = appToJson(
      makeApp({ composePath: "/etc/apps/myapp/compose.yaml" }),
    );
    expect(result.composeFile).toBe("compose.yaml");
  });

  // ── No appbay.yaml (appbayConfig === null) ────────────────────────────────

  it("namespace defaults to 'default' when appbayConfig is null", () => {
    const result = appToJson(makeApp({ appbayConfig: null }));
    expect(result.namespace).toBe("default");
  });

  it("hasAppbayYaml is false when appbayConfig is null", () => {
    const result = appToJson(makeApp({ appbayConfig: null }));
    expect(result.hasAppbayYaml).toBe(false);
  });

  // ── With appbay.yaml present ──────────────────────────────────────────────

  it("reads namespace from appbayConfig when present", () => {
    const result = appToJson(
      makeApp({
        appbayConfig: { namespace: "acme" } as never,
      }),
    );
    expect(result.namespace).toBe("acme");
  });

  it("hasAppbayYaml is true when appbayConfig is non-null", () => {
    const result = appToJson(
      makeApp({ appbayConfig: { namespace: "x" } as never }),
    );
    expect(result.hasAppbayYaml).toBe(true);
  });

  it("namespace defaults to 'default' when appbayConfig.namespace is undefined", () => {
    const result = appToJson(
      // appbayConfig exists but has no namespace key
      makeApp({ appbayConfig: { collection: ["x"] } as never }),
    );
    expect(result.namespace).toBe("default");
  });

  // ── Errors count ──────────────────────────────────────────────────────────

  it("errors is 0 when errors array is empty", () => {
    const result = appToJson(makeApp({ errors: [] }));
    expect(result.errors).toBe(0);
  });

  it("errors reflects the length of the errors array", () => {
    const result = appToJson(
      makeApp({
        errors: [
          { file: "/etc/apps/foo/appbay.yaml", message: "parse error" },
          { file: "/etc/apps/foo/docker-compose.yml", message: "invalid yaml" },
        ],
      }),
    );
    expect(result.errors).toBe(2);
  });

  it("errors is a number, not an array", () => {
    const result = appToJson(makeApp({ errors: [{ file: "f", message: "m" }] }));
    expect(typeof result.errors).toBe("number");
  });

  // ── Output shape ──────────────────────────────────────────────────────────

  it("output object has exactly the expected keys", () => {
    const result = appToJson(makeApp());
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(
      ["composeFile", "dir", "errors", "hasAppbayYaml", "name", "namespace"],
    );
  });

  it("all returned values are JSON-serializable (no undefined fields)", () => {
    const result = appToJson(makeApp());
    const serialized = JSON.stringify(result);
    const reparsed = JSON.parse(serialized) as Record<string, unknown>;
    // JSON.stringify drops undefined values — reparsed should have same keys
    expect(Object.keys(reparsed).sort()).toEqual(Object.keys(result).sort());
  });
});
