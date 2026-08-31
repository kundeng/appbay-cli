/**
 * Appbay database package — Drizzle ORM client, schema exports, and
 * connection factory for the SQLite metadata cache.
 *
 * The database lives at $APPBAY_HOME/var/lib/appbay.db and is a
 * rebuildable cache. The filesystem is the source of truth.
 */

import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";

import * as schema from "./schema.js";

// Re-export all table definitions and their inferred types
export {
  apps,
  traits,
  deploys,
  generatedValues,
  overlays,
  secretsMeta,
  users,
  sessions,
  jobs,
} from "./schema.js";

/** The full schema object for use with Drizzle's relational query API. */
export { schema };

// Re-export commonly used Drizzle ORM utilities so consumers do not need
// a direct dependency on drizzle-orm (avoids duplicate-package type errors).
export { eq, sql, desc, asc } from "drizzle-orm";

// Re-export CacheStore and its types for consumers
export { CacheStore } from "./cache.js";
export type {
  DiscoveredAppForCache,
  GeneratedValueForCache,
  DeployRecord,
  AppRow,
  DeployRow,
  RebuildResult,
} from "./cache.js";

/** Type alias for the Drizzle database instance with full schema. */
export type AppbayDatabase = BetterSQLite3Database<typeof schema>;

/**
 * Create a new Drizzle database connection backed by SQLite.
 *
 * Enables WAL mode for better concurrent read performance and turns on
 * foreign key constraint enforcement (SQLite disables them by default).
 *
 * @param dbPath - Absolute path to the SQLite database file.
 *                 Typically `$APPBAY_HOME/var/lib/appbay.db`.
 * @returns A configured Drizzle ORM database instance.
 */
export function createDatabase(dbPath: string): AppbayDatabase {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // Auto-create tables if they don't exist (SQLite is a rebuildable cache)
  bootstrapSchema(sqlite);
  return drizzle(sqlite, { schema });
}

/** Create all tables if they don't exist. Idempotent. */
function bootstrapSchema(sqlite: Database.Database): void {
  sqlite.exec(SCHEMA_SQL);
}

/**
 * Create a temporary in-memory database for testing.
 *
 * Uses the same WAL + foreign key pragmas as the production database
 * and applies the schema by executing CREATE TABLE statements directly.
 *
 * @returns A configured Drizzle ORM database instance backed by `:memory:`.
 */
/** Schema SQL for bootstrapping. Idempotent (IF NOT EXISTS). */
const SCHEMA_SQL = `
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

    CREATE TABLE IF NOT EXISTS traits (
      id TEXT PRIMARY KEY,
      app_name TEXT NOT NULL REFERENCES apps(name),
      service_name TEXT,
      trait_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      properties_json TEXT
    );

    CREATE TABLE IF NOT EXISTS deploys (
      id TEXT PRIMARY KEY,
      app_name TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_snapshot_json TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS generated_values (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      environment TEXT NOT NULL,
      service TEXT NOT NULL,
      var_name TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS overlays (
      id TEXT PRIMARY KEY,
      app_name TEXT NOT NULL,
      when_clause_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS secrets_meta (
      id TEXT PRIMARY KEY,
      app_name TEXT NOT NULL,
      service_name TEXT,
      env_var TEXT NOT NULL,
      uri TEXT NOT NULL,
      provider TEXT NOT NULL,
      last_checked_at TEXT
    );

    -- 🚨 No password_hash: RFC-001 §1 deleted AppBay's own accounts, so there is no
    -- credential for this process to hold. See packages/db/src/schema.ts.
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT,
      priority INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT
    );
`;

export function createTestDatabase(): AppbayDatabase {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(SCHEMA_SQL);
  return drizzle(sqlite, { schema });
}
