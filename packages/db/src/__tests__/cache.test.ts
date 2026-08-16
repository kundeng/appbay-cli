/**
 * Tests for CacheStore — the SQLite cache layer that mirrors filesystem state.
 *
 * These tests verify that the CacheStore correctly syncs apps, generated values,
 * and deploy records into SQLite, and that the rebuild operation regenerates
 * the cache from filesystem state.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { randomUUID } from "node:crypto";

import { createTestDatabase, apps, generatedValues, deploys, type AppbayDatabase } from "../index.js";
import {
  CacheStore,
  type DiscoveredAppForCache,
  type GeneratedValueForCache,
  type DeployRecord,
} from "../cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

/** Create a temporary directory for test fixtures. */
function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "appbay-cache-test-"));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CacheStore", () => {
  let db: AppbayDatabase;
  let cache: CacheStore;

  beforeEach(() => {
    db = createTestDatabase();
    cache = new CacheStore(db);
  });

  // -------------------------------------------------------------------------
  // 1. syncApps inserts discovered apps into SQLite
  // -------------------------------------------------------------------------

  it("syncApps inserts discovered apps into SQLite", async () => {
    const discovered: DiscoveredAppForCache[] = [
      { name: "jellyfin", project: "homelab", environment: "prod" },
      { name: "traefik", project: "system", environment: "prod" },
    ];

    await cache.syncApps(discovered);

    const result = db.select().from(apps).all();
    expect(result).toHaveLength(2);

    const names = result.map((r: any) => r.name).sort();
    expect(names).toEqual(["jellyfin", "traefik"]);

    const jellyfin = result.find((r: any) => r.name === "jellyfin")!;
    expect(jellyfin.project).toBe("homelab");
    expect(jellyfin.environment).toBe("prod");
    expect(jellyfin.status).toBe("stopped");
    expect(jellyfin.id).toBeTruthy();
    expect(jellyfin.createdAt).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 2. syncApps updates existing apps (upsert)
  // -------------------------------------------------------------------------

  it("syncApps updates existing apps via upsert", async () => {
    // Initial insert
    await cache.syncApps([
      { name: "ollama", project: "devlab", environment: "dev" },
    ]);

    const initial = db.select().from(apps).all();
    expect(initial).toHaveLength(1);
    expect(initial[0]!.project).toBe("devlab");

    // Update the same app with new project
    await cache.syncApps([
      { name: "ollama", project: "homelab", environment: "prod" },
    ]);

    const updated = db.select().from(apps).all();
    expect(updated).toHaveLength(1);
    expect(updated[0]!.project).toBe("homelab");
    expect(updated[0]!.environment).toBe("prod");
    // ID should remain the same (update, not re-insert)
    expect(updated[0]!.id).toBe(initial[0]!.id);
  });

  // -------------------------------------------------------------------------
  // 3. getApps filters by project
  // -------------------------------------------------------------------------

  it("getApps filters by project", async () => {
    await cache.syncApps([
      { name: "jellyfin", project: "homelab", environment: "prod" },
      { name: "traefik", project: "system", environment: "prod" },
      { name: "ollama", project: "homelab", environment: "dev" },
    ]);

    const homelabApps = await cache.getApps({ project: "homelab" });
    expect(homelabApps).toHaveLength(2);
    expect(homelabApps.map((a: any) => a.name).sort()).toEqual([
      "jellyfin",
      "ollama",
    ]);

    const systemApps = await cache.getApps({ project: "system" });
    expect(systemApps).toHaveLength(1);
    expect(systemApps[0]!.name).toBe("traefik");

    // Filter by both project and environment
    const homelabProd = await cache.getApps({
      project: "homelab",
      environment: "prod",
    });
    expect(homelabProd).toHaveLength(1);
    expect(homelabProd[0]!.name).toBe("jellyfin");

    // No filter returns all
    const allApps = await cache.getApps();
    expect(allApps).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 4. syncGeneratedValues populates cache
  // -------------------------------------------------------------------------

  it("syncGeneratedValues populates the generated values cache", async () => {
    const values: GeneratedValueForCache[] = [
      {
        project: "homelab",
        environment: "prod",
        service: "jellyfin",
        varName: "DB_PASSWORD",
        value: "s3cret123",
        createdAt: now(),
      },
      {
        project: "homelab",
        environment: "prod",
        service: "nextcloud",
        varName: "ADMIN_PASSWORD",
        value: "adm1n!pass",
        createdAt: now(),
      },
    ];

    await cache.syncGeneratedValues(values);

    const result = db.select().from(generatedValues).all();
    expect(result).toHaveLength(2);

    const jf = result.find((r: any) => r.service === "jellyfin")!;
    expect(jf.project).toBe("homelab");
    expect(jf.varName).toBe("DB_PASSWORD");
    expect(jf.value).toBe("s3cret123");

    // Calling syncGeneratedValues again replaces all values
    await cache.syncGeneratedValues([values[0]!]);
    const afterResync = db.select().from(generatedValues).all();
    expect(afterResync).toHaveLength(1);
    expect(afterResync[0]!.varName).toBe("DB_PASSWORD");
  });

  // -------------------------------------------------------------------------
  // 5. recordDeploy inserts deploy record
  // -------------------------------------------------------------------------

  it("recordDeploy inserts a deploy record", async () => {
    const deployId = randomUUID();
    const startTime = now();

    const deploy: DeployRecord = {
      id: deployId,
      appName: "jellyfin",
      status: "completed",
      planSnapshotJson: JSON.stringify({ apps: ["jellyfin"] }),
      startedAt: startTime,
      completedAt: now(),
    };

    await cache.recordDeploy(deploy);

    const result = db.select().from(deploys).all();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(deployId);
    expect(result[0]!.appName).toBe("jellyfin");
    expect(result[0]!.status).toBe("completed");
    expect(result[0]!.planSnapshotJson).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 6. rebuild clears and repopulates everything
  // -------------------------------------------------------------------------

  it("rebuild clears and repopulates everything from filesystem", async () => {
    const tmpDir = createTmpDir();
    const appsDir = join(tmpDir, "etc", "apps");
    const stateDir = join(tmpDir, "var", "lib", "state");

    try {
      // Create fixture app directories
      const jellyfinDir = join(appsDir, "jellyfin");
      const ollamaDir = join(appsDir, "ollama");
      mkdirSync(jellyfinDir, { recursive: true });
      mkdirSync(ollamaDir, { recursive: true });

      // Write compose files (required for discovery)
      writeFileSync(
        join(jellyfinDir, "docker-compose.yml"),
        "services:\n  jellyfin:\n    image: jellyfin/jellyfin",
      );
      writeFileSync(
        join(ollamaDir, "docker-compose.yml"),
        "services:\n  ollama:\n    image: ollama/ollama",
      );

      // Write appbay.yaml for jellyfin (ollama has no appbay.yaml)
      writeFileSync(
        join(jellyfinDir, "appbay.yaml"),
        "project: homelab\nenvironment: prod",
      );

      // Write generated-values.yaml
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "generated-values.yaml"),
        stringify({
          version: 1,
          values: [
            {
              key: {
                project: "homelab",
                environment: "prod",
                service: "jellyfin",
                varName: "DB_PASSWORD",
              },
              value: "rebuilt-value",
              generator: "password:16",
              createdAt: now(),
            },
          ],
        }),
      );

      // Pre-populate some data to verify it gets cleared
      await cache.syncApps([{ name: "old-app", project: "stale" }]);
      expect(db.select().from(apps).all()).toHaveLength(1);

      // Run rebuild
      const result = await cache.rebuild({
        appsDir,
        stateDir,
      });

      expect(result.appsSync).toBe(2);
      expect(result.generatedValuesSync).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Verify apps were synced
      const cachedApps = db.select().from(apps).all();
      expect(cachedApps).toHaveLength(2);
      const names = cachedApps.map((a: any) => a.name).sort();
      expect(names).toEqual(["jellyfin", "ollama"]);

      // Verify jellyfin has metadata from appbay.yaml
      const jf = cachedApps.find((a: any) => a.name === "jellyfin")!;
      expect(jf.project).toBe("homelab");
      expect(jf.environment).toBe("prod");

      // Verify ollama has defaults (no appbay.yaml)
      const ol = cachedApps.find((a: any) => a.name === "ollama")!;
      expect(ol.project).toBe("default");

      // Verify generated values were synced
      const gv = db.select().from(generatedValues).all();
      expect(gv).toHaveLength(1);
      expect(gv[0]!.value).toBe("rebuilt-value");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 6b. recordDeploy upserts status updates (same ID)
  // -------------------------------------------------------------------------

  it("recordDeploy upserts status updates for the same deploy ID", async () => {
    const deployId = randomUUID();
    const startTime = now();

    // First call: status = "running"
    await cache.recordDeploy({
      id: deployId,
      appName: "jellyfin",
      status: "running",
      startedAt: startTime,
    });

    const after_running = db.select().from(deploys).all();
    expect(after_running).toHaveLength(1);
    expect(after_running[0]!.status).toBe("running");

    // Second call: same ID, status = "completed"
    const completedTime = now();
    await cache.recordDeploy({
      id: deployId,
      appName: "jellyfin",
      status: "completed",
      startedAt: startTime,
      completedAt: completedTime,
    });

    const after_completed = db.select().from(deploys).all();
    // Should still be one row — upserted, not duplicated
    expect(after_completed).toHaveLength(1);
    expect(after_completed[0]!.status).toBe("completed");
    expect(after_completed[0]!.completedAt).toBe(completedTime);
    expect(after_completed[0]!.id).toBe(deployId);
  });

  // -------------------------------------------------------------------------
  // 6c. getDeploy returns a single record by ID
  // -------------------------------------------------------------------------

  it("getDeploy returns a single record by ID, null for missing", async () => {
    const deployId = randomUUID();
    await cache.recordDeploy({
      id: deployId,
      appName: "traefik",
      status: "completed",
      startedAt: now(),
    });

    const found = await cache.getDeploy(deployId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(deployId);
    expect(found!.appName).toBe("traefik");

    const missing = await cache.getDeploy(randomUUID());
    expect(missing).toBeNull();
  });

  // -------------------------------------------------------------------------
  // rebuild: missing appsDir → error recorded, rebuild still returns
  // -------------------------------------------------------------------------

  it("rebuild records an error when appsDir does not exist", async () => {
    const result = await cache.rebuild({
      appsDir: "/tmp/appbay-test-does-not-exist-appsdir-12345",
      stateDir: "/tmp/appbay-test-does-not-exist-statedir-12345",
    });

    // Apps scan should fail gracefully with an error message
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Apps scan failed");
    expect(result.appsSync).toBe(0);
    // generatedValuesSync stays 0 — ENOENT for generated-values.yaml is silent
    expect(result.generatedValuesSync).toBe(0);
  });

  // -------------------------------------------------------------------------
  // rebuild: missing generated-values.yaml (ENOENT) → silent, no error
  // -------------------------------------------------------------------------

  it("rebuild silently ignores missing generated-values.yaml (ENOENT)", async () => {
    const tmpDir = createTmpDir();
    const appsDir = join(tmpDir, "etc", "apps");
    const stateDir = join(tmpDir, "var", "lib", "state");

    try {
      // Create a valid (empty) apps directory — no apps, no docker-compose.yml
      mkdirSync(appsDir, { recursive: true });
      // stateDir exists but generated-values.yaml is absent
      mkdirSync(stateDir, { recursive: true });

      const result = await cache.rebuild({ appsDir, stateDir });

      expect(result.errors).toHaveLength(0);
      expect(result.appsSync).toBe(0);
      expect(result.generatedValuesSync).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // rebuild: app directory without docker-compose.yml is skipped
  // -------------------------------------------------------------------------

  it("rebuild skips app directories that lack docker-compose.yml", async () => {
    const tmpDir = createTmpDir();
    const appsDir = join(tmpDir, "etc", "apps");
    const stateDir = join(tmpDir, "var", "lib", "state");

    try {
      // Create a directory without compose file (should be skipped)
      mkdirSync(join(appsDir, "bare-dir"), { recursive: true });
      // Create a valid app directory with compose
      const validDir = join(appsDir, "valid-app");
      mkdirSync(validDir, { recursive: true });
      writeFileSync(join(validDir, "docker-compose.yml"), "services: {}");
      mkdirSync(stateDir, { recursive: true });

      const result = await cache.rebuild({ appsDir, stateDir });

      expect(result.errors).toHaveLength(0);
      expect(result.appsSync).toBe(1);

      const cachedApps = db.select().from(apps).all();
      expect(cachedApps).toHaveLength(1);
      expect(cachedApps[0]!.name).toBe("valid-app");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 7. getDeploys returns most recent first
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // getApps: single-condition branch via environment key
  // -------------------------------------------------------------------------

  it("getApps filters by environment alone (single-condition branch)", async () => {
    // Exercises the `conditions.length === 1` path using the `environment`
    // column (not `project`) — distinct from the existing project-only test.
    const discovered: DiscoveredAppForCache[] = [
      { name: "app-a", project: "homelab", environment: "prod" },
      { name: "app-b", project: "devlab", environment: "dev" },
      { name: "app-c", project: "homelab", environment: "dev" },
    ];
    await cache.syncApps(discovered);

    const devApps = await cache.getApps({ environment: "dev" });
    expect(devApps).toHaveLength(2);
    expect(devApps.map((a) => a.name).sort()).toEqual(["app-b", "app-c"]);
  });

  // -------------------------------------------------------------------------
  // rebuild: non-ENOENT error on generated-values.yaml
  // -------------------------------------------------------------------------

  it("rebuild records an error when generated-values.yaml exists but contains invalid YAML", async () => {
    // Exercises the `else` branch in the catch block:
    //   } else {
    //     result.errors.push(`Generated values sync failed: ${msg}`);
    //   }
    // A YAML SyntaxError is not ENOENT, so it takes this path.
    const tmpDir = createTmpDir();
    const appsDir = join(tmpDir, "etc", "apps");
    const stateDir = join(tmpDir, "var", "lib", "state");

    try {
      // Valid apps dir with one app so appsSync succeeds cleanly.
      const appDir = join(appsDir, "myapp");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, "docker-compose.yml"), "services: {}");

      // State dir with invalid YAML content (triggers parse-level error).
      mkdirSync(stateDir, { recursive: true });
      // An unclosed brace is a YAML syntax error that causes parse() to throw.
      writeFileSync(join(stateDir, "generated-values.yaml"), "{ unclosed: [");

      const result = await cache.rebuild({ appsDir, stateDir });

      // Apps were synced successfully.
      expect(result.appsSync).toBe(1);

      // The non-ENOENT YAML parse error was captured, not silenced.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/Generated values sync failed:/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 7. getDeploys returns most recent first
  // -------------------------------------------------------------------------

  it("getDeploys returns most recent first", async () => {
    // Insert deploys with different timestamps
    const deploys: DeployRecord[] = [
      {
        id: randomUUID(),
        appName: "jellyfin",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: randomUUID(),
        appName: "ollama",
        status: "completed",
        startedAt: "2026-03-01T00:00:00.000Z",
      },
      {
        id: randomUUID(),
        appName: "traefik",
        status: "failed",
        startedAt: "2026-02-01T00:00:00.000Z",
        error: "timeout",
      },
    ];

    for (const d of deploys) {
      await cache.recordDeploy(d);
    }

    const result = await cache.getDeploys();
    expect(result).toHaveLength(3);
    // Most recent first
    expect(result[0]!.appName).toBe("ollama");
    expect(result[1]!.appName).toBe("traefik");
    expect(result[2]!.appName).toBe("jellyfin");

    // Test limit
    const limited = await cache.getDeploys(2);
    expect(limited).toHaveLength(2);
    expect(limited[0]!.appName).toBe("ollama");
  });
});
