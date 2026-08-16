import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { discoverApps } from "../discover.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");

// ---------------------------------------------------------------------------
// 1. Discovers valid app with both files
// ---------------------------------------------------------------------------

describe("discoverApps", () => {
  it("discovers a valid app with compose and appbay.yaml", async () => {
    const apps = await discoverApps({ appsDir: FIXTURES_DIR });
    const validApp = apps.find((a) => a.name === "valid-app");

    expect(validApp).toBeDefined();
    expect(validApp!.dir).toBe(join(FIXTURES_DIR, "valid-app"));
    expect(validApp!.composePath).toBe(
      join(FIXTURES_DIR, "valid-app", "docker-compose.yml"),
    );
    expect(validApp!.composeContent).toHaveProperty("services");
    expect(validApp!.appbayConfig).not.toBeNull();
    expect(validApp!.appbayConfig!.project).toBe("homelab");
    expect(validApp!.appbayConfig!.environment).toBe("prod");
    expect(validApp!.appbayConfig!.collection).toEqual(["web-stack"]);
    expect(validApp!.errors).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 2. Discovers app with compose only (appbayConfig is null)
  // ---------------------------------------------------------------------------

  it("discovers an app with compose only (no appbay.yaml)", async () => {
    const apps = await discoverApps({ appsDir: FIXTURES_DIR });
    const minimalApp = apps.find((a) => a.name === "minimal-app");

    expect(minimalApp).toBeDefined();
    expect(minimalApp!.appbayConfig).toBeNull();
    expect(minimalApp!.composeContent).toHaveProperty("services");
    expect(minimalApp!.errors).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 3. Reports error for invalid appbay.yaml but still discovers the app
  // ---------------------------------------------------------------------------

  it("reports error for invalid appbay.yaml but still discovers the app", async () => {
    const apps = await discoverApps({ appsDir: FIXTURES_DIR });
    const invalidApp = apps.find((a) => a.name === "invalid-yaml");

    expect(invalidApp).toBeDefined();
    expect(invalidApp!.appbayConfig).toBeNull();
    expect(invalidApp!.composeContent).toHaveProperty("services");
    expect(invalidApp!.errors.length).toBeGreaterThan(0);

    // Error should reference the appbay.yaml file path.
    const appbayError = invalidApp!.errors.find((e) =>
      e.file.endsWith("appbay.yaml"),
    );
    expect(appbayError).toBeDefined();
    expect(appbayError!.message).toContain("appbay.yaml");
    expect(appbayError!.details).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 4. Skips directory with no compose file
  // ---------------------------------------------------------------------------

  it("skips directory with no compose file", async () => {
    const apps = await discoverApps({ appsDir: FIXTURES_DIR });
    const noCompose = apps.find((a) => a.name === "no-compose");

    expect(noCompose).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 5. Returns empty array for empty apps dir
  // ---------------------------------------------------------------------------

  it("returns empty array for empty apps dir", async () => {
    const emptyDir = join(FIXTURES_DIR, "empty-dir");
    const apps = await discoverApps({ appsDir: emptyDir });

    expect(apps).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // 6. Handles non-existent directory gracefully
  // ---------------------------------------------------------------------------

  it("handles non-existent directory gracefully", async () => {
    const apps = await discoverApps({
      appsDir: "/tmp/appbay-test-nonexistent-dir-xyz",
    });

    expect(apps).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // 7a. Reports error when compose file parses to a non-object YAML value
  // ---------------------------------------------------------------------------

  it("reports error when compose file parses to a YAML array (not an object)", async () => {
    const apps = await discoverApps({ appsDir: FIXTURES_DIR });
    const badCompose = apps.find((a) => a.name === "compose-not-object");

    expect(badCompose).toBeDefined();
    // composeContent should be empty (default {}) since parse failed to return object
    expect(badCompose!.composeContent).toEqual({});
    // An error should be recorded pointing at the compose file
    const composeError = badCompose!.errors.find((e) =>
      e.file.endsWith("docker-compose.yml"),
    );
    expect(composeError).toBeDefined();
    expect(composeError!.message).toContain("did not parse to an object");
  });

  // ---------------------------------------------------------------------------
  // 7b. Reports error when appbay.yaml exists but is not readable (non-ENOENT)
  // ---------------------------------------------------------------------------

  it("reports error when appbay.yaml is a directory (EISDIR, non-ENOENT)", async () => {
    // The fixture has a directory named "appbay.yaml" — readFile on it throws
    // EISDIR (code !== "ENOENT"), which must be recorded as an error (not silently ignored).
    const apps = await discoverApps({ appsDir: FIXTURES_DIR });
    const badApp = apps.find((a) => a.name === "appbay-yaml-is-dir");

    expect(badApp).toBeDefined();
    // Compose should parse fine.
    expect(badApp!.composeContent).toHaveProperty("services");
    // appbayConfig should be null since we couldn't read it.
    expect(badApp!.appbayConfig).toBeNull();
    // An error should be recorded pointing at appbay.yaml.
    const appbayError = badApp!.errors.find((e) =>
      e.file.endsWith("appbay.yaml"),
    );
    expect(appbayError).toBeDefined();
    expect(appbayError!.message).toContain("Failed to parse appbay.yaml");
  });

  // ---------------------------------------------------------------------------
  // Alternate compose file names (findComposeFile priority order)
  //
  // `findComposeFile` tries four names in order:
  //   docker-compose.yml → docker-compose.yaml → compose.yml → compose.yaml
  // All fixtures use the first name; the alternatives are untested without
  // dynamic temp directories.
  // ---------------------------------------------------------------------------

  it("discovers an app whose compose file is named 'docker-compose.yaml'", async () => {
    const tmpAppsDir = mkdtempSync(join(tmpdir(), "appbay-discover-test-"));
    try {
      const appDir = join(tmpAppsDir, "yaml-app");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, "docker-compose.yaml"), "services:\n  web:\n    image: nginx:latest\n");

      const apps = await discoverApps({ appsDir: tmpAppsDir });
      const found = apps.find((a) => a.name === "yaml-app");
      expect(found).toBeDefined();
      expect(found!.composePath).toContain("docker-compose.yaml");
      expect(found!.errors).toHaveLength(0);
    } finally {
      rmSync(tmpAppsDir, { recursive: true, force: true });
    }
  });

  it("discovers an app whose compose file is named 'compose.yml'", async () => {
    const tmpAppsDir = mkdtempSync(join(tmpdir(), "appbay-discover-test-"));
    try {
      const appDir = join(tmpAppsDir, "compose-yml-app");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, "compose.yml"), "services:\n  app:\n    image: alpine:latest\n");

      const apps = await discoverApps({ appsDir: tmpAppsDir });
      const found = apps.find((a) => a.name === "compose-yml-app");
      expect(found).toBeDefined();
      expect(found!.composePath).toContain("compose.yml");
      expect(found!.errors).toHaveLength(0);
    } finally {
      rmSync(tmpAppsDir, { recursive: true, force: true });
    }
  });

  it("discovers an app whose compose file is named 'compose.yaml'", async () => {
    const tmpAppsDir = mkdtempSync(join(tmpdir(), "appbay-discover-test-"));
    try {
      const appDir = join(tmpAppsDir, "compose-yaml-app");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, "compose.yaml"), "services:\n  app:\n    image: redis:alpine\n");

      const apps = await discoverApps({ appsDir: tmpAppsDir });
      const found = apps.find((a) => a.name === "compose-yaml-app");
      expect(found).toBeDefined();
      expect(found!.composePath).toContain("compose.yaml");
      expect(found!.errors).toHaveLength(0);
    } finally {
      rmSync(tmpAppsDir, { recursive: true, force: true });
    }
  });

  it("prefers docker-compose.yml over compose.yml when both exist", async () => {
    // Verifies the priority order: docker-compose.yml is checked first
    const tmpAppsDir = mkdtempSync(join(tmpdir(), "appbay-discover-test-"));
    try {
      const appDir = join(tmpAppsDir, "priority-app");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, "docker-compose.yml"), "services:\n  primary:\n    image: nginx:latest\n");
      writeFileSync(join(appDir, "compose.yml"), "services:\n  secondary:\n    image: alpine:latest\n");

      const apps = await discoverApps({ appsDir: tmpAppsDir });
      const found = apps.find((a) => a.name === "priority-app");
      expect(found).toBeDefined();
      // docker-compose.yml takes priority
      expect(found!.composePath).toContain("docker-compose.yml");
      expect(found!.composeContent.services).toHaveProperty("primary");
    } finally {
      rmSync(tmpAppsDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // 7. Discovers multiple apps sorted by name
  // ---------------------------------------------------------------------------

  it("discovers multiple apps sorted by name", async () => {
    const apps = await discoverApps({ appsDir: FIXTURES_DIR });

    // Should find valid-app, minimal-app, and invalid-yaml (all have compose files).
    // Should NOT find no-compose or empty-dir.
    const names = apps.map((a) => a.name);

    expect(names).toContain("valid-app");
    expect(names).toContain("minimal-app");
    expect(names).toContain("invalid-yaml");
    expect(names).not.toContain("no-compose");
    expect(names).not.toContain("empty-dir");

    // Verify alphabetical sort order.
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });
});
