/**
 * Zod schemas for file-based state in `$APPBAY_HOME/var/lib/state/`.
 *
 * These YAML files are the source of truth for runtime state. SQLite caches
 * this data for UI query performance but can be rebuilt from files at any time
 * via `appbay rebuild-cache`.
 *
 * State files:
 *   - `generated-values.yaml`  -- persisted magic variable values
 *   - `active-apps.yaml`       -- currently active app set with status
 *
 * See design.md "Storage Architecture > State Store" for details.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Generated Values (var/lib/state/generated-values.yaml)
// ---------------------------------------------------------------------------

/**
 * Composite key for a generated value.
 * Values are keyed by (project, environment, service, varName) to ensure
 * deterministic re-renders -- the same key always returns the same value.
 */
export const GeneratedValueKeySchema = z.object({
  project: z.string(),
  environment: z.string(),
  service: z.string(),
  varName: z.string(),
});

export type GeneratedValueKey = z.infer<typeof GeneratedValueKeySchema>;

/** A single persisted generated value with its creation metadata. */
export const GeneratedValueSchema = z.object({
  key: GeneratedValueKeySchema,
  /** The generated value (e.g. random password, UUID). */
  value: z.string(),
  /** Generator specification that produced this value (e.g. "password:16", "uuid"). */
  generator: z.string(),
  /** ISO 8601 timestamp of when the value was first generated. */
  createdAt: z.string().datetime(),
});

export type GeneratedValue = z.infer<typeof GeneratedValueSchema>;

/** Top-level schema for the generated-values.yaml state file. */
export const GeneratedValuesFileSchema = z.object({
  /** Schema version for forward compatibility. */
  version: z.literal(1),
  /** All persisted generated values. */
  values: z.array(GeneratedValueSchema),
});

export type GeneratedValuesFile = z.infer<typeof GeneratedValuesFileSchema>;

// ---------------------------------------------------------------------------
// Active Apps (var/lib/state/active-apps.yaml)
// ---------------------------------------------------------------------------

/** Status of a deployed app. */
export const AppStatusSchema = z.enum([
  "running",
  "stopped",
  "error",
  "unknown",
]);

export type AppStatus = z.infer<typeof AppStatusSchema>;

/** A single app entry in the active apps registry. */
export const ActiveAppEntrySchema = z.object({
  name: z.string(),
  project: z.string(),
  environment: z.string(),
  status: AppStatusSchema,
  /** ISO 8601 timestamp of the last successful deploy. */
  lastDeploy: z.string().datetime().optional(),
});

export type ActiveAppEntry = z.infer<typeof ActiveAppEntrySchema>;

/** Top-level schema for the active-apps.yaml state file. */
export const ActiveAppsSchema = z.object({
  /** Schema version for forward compatibility. */
  version: z.literal(1),
  /** All tracked apps and their current status. */
  apps: z.array(ActiveAppEntrySchema),
});

export type ActiveApps = z.infer<typeof ActiveAppsSchema>;

// ---------------------------------------------------------------------------
// Deploy Record
// ---------------------------------------------------------------------------

/** Status of a deployment operation. */
export const DeployStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "failed",
  "cancelled",
]);

export type DeployStatus = z.infer<typeof DeployStatusSchema>;

/** A record of a single deployment operation. */
export const DeployRecordSchema = z.object({
  /** Unique identifier for this deploy run. */
  id: z.string(),
  /** ISO 8601 timestamp of when the deploy was initiated. */
  timestamp: z.string().datetime(),
  /** Names of apps included in this deploy. */
  apps: z.array(z.string()),
  /** Current status of the deploy. */
  status: DeployStatusSchema,
  /** Hash of the plan that was applied (for audit trail). */
  planHash: z.string().optional(),
  /** Error message if the deploy failed. */
  error: z.string().optional(),
});

export type DeployRecord = z.infer<typeof DeployRecordSchema>;
