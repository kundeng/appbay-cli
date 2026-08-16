/**
 * App discovery -- Stage 1 of the compiler pipeline.
 *
 * Scans `$APPBAY_HOME/etc/apps/` for directories containing a Docker Compose
 * file. For each directory:
 *   - App name = directory name
 *   - Parse `appbay.yaml` (optional) using AppbayYamlSchema
 *   - Parse compose file as raw YAML
 *   - Collect parse/validation errors without aborting discovery
 *
 * Returns `DiscoveredApp[]` sorted by app name for deterministic output.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { AppbayYamlSchema } from "../schemas/appbay-yaml.js";
import type { DiscoverOptions, DiscoveredApp, DiscoveryError } from "./types.js";

/**
 * Compose file names to search for, in priority order.
 * The first match wins.
 */
const COMPOSE_FILE_NAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
] as const;

/** The appbay metadata file name. */
const APPBAY_YAML = "appbay.yaml";

/**
 * Scan the apps directory and discover all valid app definitions.
 *
 * Directories without a compose file are silently skipped.
 * Parse errors are recorded in `errors` but the app is still returned
 * so callers can report actionable diagnostics.
 */
export async function discoverApps(
  options: DiscoverOptions,
): Promise<DiscoveredApp[]> {
  const { appsDir } = options;

  // If the directory does not exist, return empty rather than throwing.
  let entries: string[];
  try {
    entries = await readdir(appsDir);
  } catch {
    return [];
  }

  const apps: DiscoveredApp[] = [];

  for (const entry of entries) {
    const appDir = join(appsDir, entry);

    // Only consider directories.
    try {
      const info = await stat(appDir);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }

    // Find the first matching compose file.
    const composePath = await findComposeFile(appDir);
    if (composePath === null) {
      // No compose file -- skip this directory.
      continue;
    }

    const errors: DiscoveryError[] = [];

    // Parse the compose file.
    let composeContent: Record<string, unknown> = {};
    try {
      const raw = await readFile(composePath, "utf-8");
      const parsed = parseYaml(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        composeContent = parsed as Record<string, unknown>;
      } else {
        errors.push({
          file: composePath,
          message: "Compose file did not parse to an object",
        });
      }
    } catch (err) {
      errors.push({
        file: composePath,
        message: `Failed to parse compose YAML: ${err instanceof Error ? err.message : String(err)}`,
        details: err,
      });
    }

    // Parse appbay.yaml (optional).
    let appbayConfig: DiscoveredApp["appbayConfig"] = null;
    const appbayPath = join(appDir, APPBAY_YAML);
    try {
      const raw = await readFile(appbayPath, "utf-8");
      const parsed = parseYaml(raw);
      const result = AppbayYamlSchema.safeParse(parsed);
      if (result.success) {
        appbayConfig = result.data;
      } else {
        errors.push({
          file: appbayPath,
          message: "Invalid appbay.yaml: Zod validation failed",
          details: result.error.issues,
        });
      }
    } catch (err) {
      // File not found is fine -- appbay.yaml is optional.
      if (isFileNotFound(err)) {
        // Leave appbayConfig as null.
      } else {
        errors.push({
          file: appbayPath,
          message: `Failed to parse appbay.yaml: ${err instanceof Error ? err.message : String(err)}`,
          details: err,
        });
      }
    }

    apps.push({
      name: entry,
      dir: appDir,
      composePath,
      composeContent,
      appbayConfig,
      errors,
    });
  }

  // Sort by name for deterministic output.
  apps.sort((a, b) => a.name.localeCompare(b.name));

  return apps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Search for the first matching compose file in a directory.
 * Returns the absolute path or null if none found.
 */
async function findComposeFile(dir: string): Promise<string | null> {
  for (const name of COMPOSE_FILE_NAMES) {
    const filePath = join(dir, name);
    try {
      const info = await stat(filePath);
      if (info.isFile()) return filePath;
    } catch {
      // File does not exist, try next.
    }
  }
  return null;
}

/** Check if an error is a "file not found" error (ENOENT). */
function isFileNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
