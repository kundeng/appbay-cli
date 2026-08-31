import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  createTestDatabase,
  createDatabase,
  apps,
  traits,
  deploys,
  generatedValues,
  overlays,
  secretsMeta,
  users,
  sessions,
  jobs,
  type AppbayDatabase,
} from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 1. Create database and verify all tables exist
// ---------------------------------------------------------------------------

describe("database creation", () => {
  it("creates all tables in an in-memory database", () => {
    const db = createTestDatabase();

    // Verify we can query each table without error (empty results expected)
    expect(db.select().from(apps).all()).toEqual([]);
    expect(db.select().from(traits).all()).toEqual([]);
    expect(db.select().from(deploys).all()).toEqual([]);
    expect(db.select().from(generatedValues).all()).toEqual([]);
    expect(db.select().from(overlays).all()).toEqual([]);
    expect(db.select().from(secretsMeta).all()).toEqual([]);
    expect(db.select().from(users).all()).toEqual([]);
    expect(db.select().from(sessions).all()).toEqual([]);
    expect(db.select().from(jobs).all()).toEqual([]);
  });

  /**
   * The list above only proves the tables it names EXIST. It cannot notice a table
   * that exists and does nothing — which is how `operators` survived: a registry
   * for a multi-host controller AppBay has never had, with zero writers and zero
   * readers, asserted-empty by a test that would have passed either way.
   *
   * Pinning the exact set catches it in both directions: a table quietly dropped,
   * and a table added ahead of anything that uses it.
   */
  it("declares exactly these tables — no more", () => {
    const db = createTestDatabase();
    const rows = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    expect(rows.map((row) => row.name)).toEqual([
      "apps",
      "deploys",
      "generated_values",
      "jobs",
      "overlays",
      "secrets_meta",
      "sessions",
      "traits",
      "users",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Insert and query an app record
// ---------------------------------------------------------------------------

describe("apps table", () => {
  let db: AppbayDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });

  it("inserts and queries an app record", () => {
    const id = randomUUID();
    const timestamp = now();

    db.insert(apps)
      .values({
        id,
        name: "jellyfin",
        project: "homelab",
        environment: "prod",
        status: "running",
        createdAt: timestamp,
      })
      .run();

    const result = db.select().from(apps).where(eq(apps.name, "jellyfin")).all();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id,
      name: "jellyfin",
      project: "homelab",
      environment: "prod",
      status: "running",
      createdAt: timestamp,
    });
  });

  it("applies default values for project, environment, and status", () => {
    db.insert(apps)
      .values({
        id: randomUUID(),
        name: "traefik",
        createdAt: now(),
      })
      .run();

    const result = db.select().from(apps).where(eq(apps.name, "traefik")).all();

    expect(result[0]!.project).toBe("default");
    expect(result[0]!.environment).toBe("default");
    expect(result[0]!.status).toBe("stopped");
  });
});

// ---------------------------------------------------------------------------
// 3. Insert and query a deploy record
// ---------------------------------------------------------------------------

describe("deploys table", () => {
  let db: AppbayDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });

  it("inserts and queries a deploy record", () => {
    const deployId = randomUUID();
    const startTime = now();

    db.insert(deploys)
      .values({
        id: deployId,
        appName: "jellyfin",
        status: "completed",
        planSnapshotJson: JSON.stringify({ apps: ["jellyfin"] }),
        startedAt: startTime,
        completedAt: now(),
      })
      .run();

    const result = db
      .select()
      .from(deploys)
      .where(eq(deploys.id, deployId))
      .all();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: deployId,
      appName: "jellyfin",
      status: "completed",
      startedAt: startTime,
    });
    expect(result[0]!.planSnapshotJson).toBeTruthy();
  });

  it("stores a failed deploy with an error message", () => {
    const deployId = randomUUID();

    db.insert(deploys)
      .values({
        id: deployId,
        appName: "nextcloud",
        status: "failed",
        startedAt: now(),
        error: "docker compose exited with code 1",
      })
      .run();

    const result = db
      .select()
      .from(deploys)
      .where(eq(deploys.id, deployId))
      .all();

    expect(result[0]!.status).toBe("failed");
    expect(result[0]!.error).toBe("docker compose exited with code 1");
  });
});

// ---------------------------------------------------------------------------
// 4. Foreign key constraint: trait references valid app
// ---------------------------------------------------------------------------

describe("foreign key constraints", () => {
  let db: AppbayDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });

  it("allows inserting a trait when the referenced app exists", () => {
    // Insert the app first
    db.insert(apps)
      .values({
        id: randomUUID(),
        name: "jellyfin",
        createdAt: now(),
      })
      .run();

    // Insert a trait referencing the app
    db.insert(traits)
      .values({
        id: randomUUID(),
        appName: "jellyfin",
        traitType: "ingress",
        scope: "service",
        serviceName: "jellyfin",
        propertiesJson: JSON.stringify({ host: "media.example.com", port: 8096 }),
      })
      .run();

    const result = db
      .select()
      .from(traits)
      .where(eq(traits.appName, "jellyfin"))
      .all();

    expect(result).toHaveLength(1);
    expect(result[0]!.traitType).toBe("ingress");
  });

  it("rejects a trait referencing a non-existent app", () => {
    expect(() => {
      db.insert(traits)
        .values({
          id: randomUUID(),
          appName: "nonexistent-app",
          traitType: "gpu",
          scope: "service",
        })
        .run();
    }).toThrow(); // SQLite foreign key constraint violation
  });

  it("rejects a session referencing a non-existent user", () => {
    expect(() => {
      db.insert(sessions)
        .values({
          id: randomUUID(),
          userId: "nonexistent-user",
          token: "abc123",
          expiresAt: now(),
          createdAt: now(),
        })
        .run();
    }).toThrow(); // SQLite foreign key constraint violation
  });
});

// ---------------------------------------------------------------------------
// 5. Unique constraint: username is unique
// ---------------------------------------------------------------------------

describe("unique constraints", () => {
  let db: AppbayDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });

  it("enforces unique username constraint", () => {
    db.insert(users)
      .values({
        id: randomUUID(),
        username: "admin",
        createdAt: now(),
      })
      .run();

    expect(() => {
      db.insert(users)
        .values({
          id: randomUUID(),
          username: "admin",
          createdAt: now(),
        })
        .run();
    }).toThrow(); // UNIQUE constraint violation
  });

  it("enforces unique app name constraint", () => {
    db.insert(apps)
      .values({
        id: randomUUID(),
        name: "traefik",
        createdAt: now(),
      })
      .run();

    expect(() => {
      db.insert(apps)
        .values({
          id: randomUUID(),
          name: "traefik",
          createdAt: now(),
        })
        .run();
    }).toThrow(); // UNIQUE constraint violation
  });

  it("enforces unique session token constraint", () => {
    const userId = randomUUID();
    db.insert(users)
      .values({
        id: userId,
        username: "admin",
        createdAt: now(),
      })
      .run();

    db.insert(sessions)
      .values({
        id: randomUUID(),
        userId,
        token: "unique-token",
        expiresAt: now(),
        createdAt: now(),
      })
      .run();

    expect(() => {
      db.insert(sessions)
        .values({
          id: randomUUID(),
          userId,
          token: "unique-token", // duplicate token
          expiresAt: now(),
          createdAt: now(),
        })
        .run();
    }).toThrow(); // UNIQUE constraint violation
  });
});

// ---------------------------------------------------------------------------
// 6. Database can be created at a temp path and destroyed
// ---------------------------------------------------------------------------

describe("file-based database lifecycle", () => {
  it("creates a database at a temp path, uses it, and destroys it", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "appbay-db-test-"));
    const dbPath = join(tmpDir, "appbay.db");

    try {
      const db = createDatabase(dbPath);

      // The database file is created by better-sqlite3 on connection.
      // We need to create tables manually since we are not running migrations.
      // For a file-based database, we use the same bootstrap SQL as createTestDatabase.
      const sqlite = new Database(dbPath);
      sqlite.pragma("foreign_keys = ON");
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS apps (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          project TEXT NOT NULL DEFAULT 'default',
          environment TEXT NOT NULL DEFAULT 'default',
          operator_id TEXT,
          status TEXT NOT NULL DEFAULT 'stopped',
          last_deployed_at TEXT,
          created_at TEXT NOT NULL
        );
      `);
      sqlite.close();

      // Re-open with Drizzle and verify it works
      const db2 = createDatabase(dbPath);
      db2.insert(apps)
        .values({
          id: randomUUID(),
          name: "test-app",
          createdAt: now(),
        })
        .run();

      const result = db2.select().from(apps).all();
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("test-app");
    } finally {
      // Clean up the temporary directory
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
