/**
 * Shared types for the compiler pipeline.
 *
 * These types are used across all compiler stages: discover, parse,
 * resolve, transform, render, and plan.
 */

import type { AppbayYaml } from "../schemas/appbay-yaml.js";

// ---------------------------------------------------------------------------
// Discovery Stage
// ---------------------------------------------------------------------------

/** Options for the app discovery scan. */
export interface DiscoverOptions {
  /** Absolute path to the apps directory (e.g., ~/.appbay/etc/apps). */
  appsDir: string;
}

/** An error encountered during app discovery (parse or validation). */
export interface DiscoveryError {
  /** Path to the file that caused the error. */
  file: string;
  /** Human-readable error message. */
  message: string;
  /** Additional error details (e.g., Zod validation issues). */
  details?: unknown;
}

/** A discovered app from the filesystem scan. */
export interface DiscoveredApp {
  /** App name (directory name). */
  name: string;
  /** Absolute path to the app directory. */
  dir: string;
  /** Absolute path to the compose file. */
  composePath: string;
  /** Parsed compose YAML as a plain object. */
  composeContent: Record<string, unknown>;
  /** Parsed and validated appbay.yaml, or null if not present. */
  appbayConfig: AppbayYaml | null;
  /** Errors encountered during discovery (app is still returned but flagged). */
  errors: DiscoveryError[];
}
