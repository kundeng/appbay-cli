/**
 * CacheStore — SQLite cache layer for the Appbay metadata cache.
 *
 * The filesystem is the source of truth. This class syncs file-derived state
 * into SQLite for fast UI rendering and query performance. The cache can be
 * fully rebuilt from files at any time via `rebuild()`.
 *
 * Write flow: files first, then call CacheStore methods to update SQLite.
 * Read flow: query SQLite for fast list/filter/search operations.
 *
 * See agents.md "Filesystem-first philosophy" and feature-ledger.md
 * "Storage Architecture" for details.
 */

import { eq, desc, and, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

import type { AppbayDatabase } from "./index.js";
import { apps, generatedValues, deploys } from "./schema.js";

// ---------------------------------------------------------------------------
// Input types — data shapes provided by callers
// ---------------------------------------------------------------------------

/** An app discovered from the filesystem, ready to cache in SQLite. */
export interface DiscoveredAppForCache {
  /** App name (directory name). */
  name: string;
  /** Project scope (defaults to "default"). */
  project?: string;
  /** Environment scope (defaults to "default"). */
  environment?: string;
  /** Operator ID for placement (optional). */
  operatorId?: string | null;
  /** App status (defaults to "stopped"). */
  status?: string;
}

/** A generated value to sync into the SQLite cache. */
export interface GeneratedValueForCache {
  /** Project scope. */
  project: string;
  /** Environment scope. */
  environment: string;
  /** Service name. */
  service: string;
  /** Variable name. */
  varName: string;
  /** The generated value. */
  value: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/** A deployment record to insert into the cache. */
export interface DeployRecord {
  /** Unique deploy ID. */
  id: string;
  /** App name that was deployed. */
  appName: string;
  /** Deploy status (pending, running, completed, failed). */
  status: string;
  /** JSON-serialized plan snapshot (optional). */
  planSnapshotJson?: string | null;
  /** ISO 8601 timestamp of deploy start. */
  startedAt: string;
  /** ISO 8601 timestamp of deploy completion (optional). */
  completedAt?: string | null;
  /** Error message if deploy failed (optional). */
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Output types — row shapes returned by queries
// ---------------------------------------------------------------------------

/** A row from the apps table. */
export interface AppRow {
  id: string;
  name: string;
  project: string;
  environment: string;
  operatorId: string | null;
  status: string;
  lastDeployedAt: string | null;
  createdAt: string;
}

/** A row from the deploys table. */
export interface DeployRow {
  id: string;
  appName: string;
  status: string;
  planSnapshotJson: string | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

/** Result summary from a full rebuild operation. */
export interface RebuildResult {
  /** Number of apps synced from the filesystem. */
  appsSync: number;
  /** Number of generated values synced from the YAML file. */
  generatedValuesSync: number;
  /** Errors encountered during rebuild (non-fatal). */
  errors: string[];
}

// ---------------------------------------------------------------------------
// CacheStore
// ---------------------------------------------------------------------------

/**
 * SQLite cache store that mirrors filesystem state for fast queries.
 *
 * All write operations assume the caller has already persisted to the
 * filesystem. CacheStore only updates the SQLite cache.
 */
export class CacheStore {
  constructor(private db: AppbayDatabase) {}

  // -------------------------------------------------------------------------
  // Sync: apps
  // -------------------------------------------------------------------------

  /**
   * Sync discovered apps into the SQLite cache.
   *
   * Uses an upsert strategy: inserts new apps and updates existing ones
   * (matched by name). This keeps the cache in sync with the filesystem
   * without requiring a full rebuild.
   */
  async syncApps(discoveredApps: DiscoveredAppForCache[]): Promise<void> {
    const now = new Date().toISOString();

    for (const app of discoveredApps) {
      const existing = this.db
        .select()
        .from(apps)
        .where(eq(apps.name, app.name))
        .all();

      if (existing.length > 0) {
        // Update existing app
        this.db
          .update(apps)
          .set({
            project: app.project ?? "default",
            environment: app.environment ?? "default",
            operatorId: app.operatorId ?? null,
            status: app.status ?? existing[0]!.status,
          })
          .where(eq(apps.name, app.name))
          .run();
      } else {
        // Insert new app
        this.db
          .insert(apps)
          .values({
            id: randomUUID(),
            name: app.name,
            project: app.project ?? "default",
            environment: app.environment ?? "default",
            operatorId: app.operatorId ?? null,
            status: app.status ?? "stopped",
            createdAt: now,
          })
          .run();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sync: generated values
  // -------------------------------------------------------------------------

  /**
   * Sync generated values from the YAML file into the SQLite cache.
   *
   * Clears existing generated values and repopulates from the provided list.
   * This ensures the cache exactly mirrors the file-based source of truth.
   */
  async syncGeneratedValues(
    values: GeneratedValueForCache[],
  ): Promise<void> {
    // Clear existing values and repopulate
    this.db.delete(generatedValues).run();

    for (const v of values) {
      this.db
        .insert(generatedValues)
        .values({
          id: randomUUID(),
          project: v.project,
          environment: v.environment,
          service: v.service,
          varName: v.varName,
          value: v.value,
          createdAt: v.createdAt,
        })
        .run();
    }
  }

  // -------------------------------------------------------------------------
  // Record: deploys
  // -------------------------------------------------------------------------

  /**
   * Record a deployment in the SQLite cache.
   *
   * Deploy history is stored exclusively in SQLite (no corresponding
   * filesystem file). This is acceptable because deploy records are
   * operational metadata, not configuration state.
   */
  async recordDeploy(deploy: DeployRecord): Promise<void> {
    // Use an upsert so callers can call recordDeploy multiple times with the
    // same ID to update status (e.g. "running" → "completed" / "failed").
    // Immutable fields (appName, startedAt) are set only on first insert.
    this.db
      .insert(deploys)
      .values({
        id: deploy.id,
        appName: deploy.appName,
        status: deploy.status,
        planSnapshotJson: deploy.planSnapshotJson ?? null,
        startedAt: deploy.startedAt,
        completedAt: deploy.completedAt ?? null,
        error: deploy.error ?? null,
      })
      .onConflictDoUpdate({
        target: deploys.id,
        set: {
          status: deploy.status,
          planSnapshotJson: deploy.planSnapshotJson ?? null,
          completedAt: deploy.completedAt ?? null,
          error: deploy.error ?? null,
        },
      })
      .run();
  }

  // -------------------------------------------------------------------------
  // Query: apps
  // -------------------------------------------------------------------------

  /**
   * Query apps from the SQLite cache with optional filtering.
   *
   * @param filter - Optional filter by project and/or environment.
   * @returns Matching app rows sorted by name.
   */
  async getApps(filter?: {
    project?: string;
    environment?: string;
  }): Promise<AppRow[]> {
    const conditions = [];

    if (filter?.project) {
      conditions.push(eq(apps.project, filter.project));
    }
    if (filter?.environment) {
      conditions.push(eq(apps.environment, filter.environment));
    }

    if (conditions.length === 0) {
      return this.db.select().from(apps).all() as AppRow[];
    }

    if (conditions.length === 1) {
      return this.db
        .select()
        .from(apps)
        .where(conditions[0]!)
        .all() as AppRow[];
    }

    return this.db
      .select()
      .from(apps)
      .where(and(...conditions))
      .all() as AppRow[];
  }

  // -------------------------------------------------------------------------
  // Query: deploys
  // -------------------------------------------------------------------------

  /**
   * Query deploy history from the SQLite cache.
   *
   * Returns deploys ordered by startedAt descending (most recent first).
   *
   * @param limit - Maximum number of records to return (default: 50).
   * @returns Deploy rows sorted by most recent first.
   */
  async getDeploys(limit: number = 50): Promise<DeployRow[]> {
    return this.db
      .select()
      .from(deploys)
      .orderBy(desc(deploys.startedAt))
      .limit(limit)
      .all() as DeployRow[];
  }

  /**
   * Get a single deploy record by ID.
   *
   * Returns null if no deploy with the given ID exists.
   */
  async getDeploy(id: string): Promise<DeployRow | null> {
    const row = this.db
      .select()
      .from(deploys)
      .where(eq(deploys.id, id))
      .get();
    return (row as DeployRow | undefined) ?? null;
  }

  // -------------------------------------------------------------------------
  // Rebuild: full cache regeneration from filesystem
  // -------------------------------------------------------------------------

  /**
   * Full rebuild: clear all cached data and resync from filesystem state.
   *
   * This reads apps from `appsDir` and generated values from
   * `stateDir/generated-values.yaml`, then repopulates the corresponding
   * SQLite tables. Deploy history is preserved (it lives only in SQLite).
   *
   * @param options.appsDir  - Path to `$APPBAY_HOME/etc/apps/`.
   * @param options.stateDir - Path to `$APPBAY_HOME/var/lib/state/`.
   * @returns Summary of what was synced and any errors encountered.
   */
  async rebuild(options: {
    appsDir: string;
    stateDir: string;
  }): Promise<RebuildResult> {
    const result: RebuildResult = {
      appsSync: 0,
      generatedValuesSync: 0,
      errors: [],
    };

    // --- Clear cached app data (preserve deploy history) ---
    this.db.delete(apps).run();

    // --- Scan apps directory ---
    try {
      const entries = await fs.readdir(options.appsDir, {
        withFileTypes: true,
      });

      const discoveredApps: DiscoveredAppForCache[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const appDir = join(options.appsDir, entry.name);
        const composePath = join(appDir, "docker-compose.yml");

        // Only consider directories containing a docker-compose.yml
        try {
          await fs.access(composePath);
        } catch {
          continue;
        }

        const app: DiscoveredAppForCache = { name: entry.name };

        // Try to read appbay.yaml for scope metadata
        const appbayPath = join(appDir, "appbay.yaml");
        try {
          const content = await fs.readFile(appbayPath, "utf-8");
          const parsed = parse(content) as Record<string, unknown>;

          if (parsed.project && typeof parsed.project === "string") {
            app.project = parsed.project;
          }
          if (parsed.environment && typeof parsed.environment === "string") {
            app.environment = parsed.environment;
          }
        } catch {
          // appbay.yaml is optional; defaults are fine
        }

        discoveredApps.push(app);
      }

      await this.syncApps(discoveredApps);
      result.appsSync = discoveredApps.length;
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Unknown error scanning apps dir";
      result.errors.push(`Apps scan failed: ${msg}`);
    }

    // --- Read generated values from YAML ---
    try {
      const gvPath = join(options.stateDir, "generated-values.yaml");
      const content = await fs.readFile(gvPath, "utf-8");
      const parsed = parse(content) as Record<string, unknown>;

      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(parsed.values)
      ) {
        const values: GeneratedValueForCache[] = [];

        for (const entry of parsed.values) {
          if (
            entry &&
            typeof entry === "object" &&
            entry.key &&
            typeof entry.key === "object"
          ) {
            const key = entry.key as Record<string, string>;
            values.push({
              project: key.project ?? "default",
              environment: key.environment ?? "default",
              service: key.service ?? "",
              varName: key.varName ?? "",
              value: (entry as Record<string, string>).value ?? "",
              createdAt:
                (entry as Record<string, string>).createdAt ??
                new Date().toISOString(),
            });
          }
        }

        await this.syncGeneratedValues(values);
        result.generatedValuesSync = values.length;
      }
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        // generated-values.yaml does not exist yet; not an error
      } else {
        const msg =
          err instanceof Error
            ? err.message
            : "Unknown error reading generated values";
        result.errors.push(`Generated values sync failed: ${msg}`);
      }
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type guard for Node.js system errors with a `code` property. */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
