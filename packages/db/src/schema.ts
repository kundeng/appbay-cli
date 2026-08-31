/**
 * Drizzle ORM SQLite schema for the Appbay metadata cache.
 *
 * This database is a CACHE, not the source of truth. The filesystem
 * ($APPBAY_HOME) is authoritative. If the database is deleted, it can
 * be fully rebuilt from filesystem state via `appbay rebuild-cache`.
 *
 * Tables:
 * - apps: App inventory cache (discovered from etc/apps/)
 * - traits: Trait assignments indexed for fast lookup
 * - deploys: Deployment history
 * - generatedValues: Magic variable cache (keyed by scope tuple)
 * - overlays: Overlay activation state
 * - secretsMeta: Secret URI registry (never stores secret values)
 * - users: Local auth users
 * - sessions: User sessions
 * - jobs: In-process SQLite-backed job queue
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Apps — inventory cache of discovered app definitions
// ---------------------------------------------------------------------------

export const apps = sqliteTable("apps", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  project: text("project").notNull().default("default"),
  environment: text("environment").notNull().default("default"),
  operatorId: text("operator_id"),
  status: text("status").notNull().default("stopped"),
  lastDeployedAt: text("last_deployed_at"),
  createdAt: text("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// Traits — trait assignments indexed for fast UI lookup
// ---------------------------------------------------------------------------

export const traits = sqliteTable("traits", {
  id: text("id").primaryKey(),
  appName: text("app_name")
    .notNull()
    .references(() => apps.name),
  serviceName: text("service_name"), // null for app-level traits
  traitType: text("trait_type").notNull(),
  scope: text("scope").notNull(), // "service" | "app"
  propertiesJson: text("properties_json"), // JSON-serialized trait config
});

// ---------------------------------------------------------------------------
// Deploys — deployment history (timestamp, status, plan snapshot)
// ---------------------------------------------------------------------------

export const deploys = sqliteTable("deploys", {
  id: text("id").primaryKey(),
  appName: text("app_name").notNull(),
  status: text("status").notNull(), // pending | running | completed | failed
  planSnapshotJson: text("plan_snapshot_json"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  error: text("error"),
});

// ---------------------------------------------------------------------------
// Generated Values — magic variable cache (keyed by scope tuple)
// ---------------------------------------------------------------------------

export const generatedValues = sqliteTable("generated_values", {
  id: text("id").primaryKey(),
  project: text("project").notNull(),
  environment: text("environment").notNull(),
  service: text("service").notNull(),
  varName: text("var_name").notNull(),
  value: text("value").notNull(),
  createdAt: text("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// Overlays — overlay activation state
// ---------------------------------------------------------------------------

export const overlays = sqliteTable("overlays", {
  id: text("id").primaryKey(),
  appName: text("app_name").notNull(),
  whenClauseJson: text("when_clause_json").notNull(),
  active: integer("active").notNull().default(0),
});

// ---------------------------------------------------------------------------
// Secrets Meta — secret URI registry (never stores actual secret values)
// ---------------------------------------------------------------------------

export const secretsMeta = sqliteTable("secrets_meta", {
  id: text("id").primaryKey(),
  appName: text("app_name").notNull(),
  serviceName: text("service_name"),
  envVar: text("env_var").notNull(),
  uri: text("uri").notNull(),
  provider: text("provider").notNull(), // vault | keepass | file | env | sops
  lastCheckedAt: text("last_checked_at"),
});

// ---------------------------------------------------------------------------
// Users — a cache of who has signed in
// ---------------------------------------------------------------------------

/**
 * 🚨 NO PASSWORD COLUMN — RFC-001 §1 deleted AppBay's own accounts.
 *
 * `password_hash` lived here because AppBay authenticated people itself. It no longer does:
 * the Caddy Security edge authenticates them and injects the identity, so there is no
 * credential for this process to hold. Storing one would recreate the second credential
 * domain §1 exists to remove — and a hash nothing verifies is worse than none, because it
 * looks like a working authentication path to whoever reads the schema next.
 *
 * ⚠️ An EXISTING database keeps the column. The table is created with `IF NOT EXISTS`, so
 * this only shapes new ones; nothing writes the column any more, and nothing reads it. The
 * stored hashes are inert rather than removed — dropping them is a migration, and the
 * migration only matters once something would otherwise trust them.
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// Sessions — user sessions for web UI and CLI auth
// ---------------------------------------------------------------------------

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  token: text("token").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// Jobs — in-process SQLite-backed job queue (no pg-boss, no Redis)
// ---------------------------------------------------------------------------

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(), // deploy | backup | rebuild-cache | pull-images | eject
  status: text("status").notNull().default("pending"),
  payloadJson: text("payload_json"),
  priority: integer("priority").default(0),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  error: text("error"),
});

// ---------------------------------------------------------------------------
// (removed) operators — a registry for a controller AppBay does not have
// ---------------------------------------------------------------------------
//
// 🚨 DO NOT RE-ADD THIS SPECULATIVELY. `operators` sat here with zero writers and
// zero readers, while the header comment above advertised an "Operator registry"
// — telling every reader the system had one. Its columns (capabilities_json,
// health_status, last_heartbeat) describe a REMOTE agent phoning home, which is a
// multi-host controller. v1 is single-host: the CLI calls @appbay/core in-process
// and exits, and S14 tier 9 was skipped for exactly this missing controller.
//
// Removal was free and needs no migration: there are none. `createDatabase()`
// re-runs idempotent DDL on every open, the filesystem is source of truth, and a
// table nothing writes is empty by construction. An existing appbay.db keeps the
// orphan table until the cache is rebuilt; nothing references it.
//
// When a controller lands, its registry belongs to THAT spec, shaped by the
// protocol it actually speaks — not by this guess made two sprints ahead of it.
