/**
 * Config service — business logic for app configuration management.
 *
 * Extracts appbay.yaml read/write, dotted-key access, and .env file
 * management from CLI commands into reusable typed functions.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ---------------------------------------------------------------------------
// YAML config (appbay.yaml)
// ---------------------------------------------------------------------------

/**
 * Resolve a dotted key path against a plain object.
 * e.g., getByPath(obj, "upstream.source") returns obj.upstream.source.
 */
export function getByPath(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a value at a dotted key path, creating intermediate objects as needed.
 */
export function setByPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Coerce a string value to a more appropriate JSON type.
 */
export function coerceValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  const num = Number(raw);
  if (!Number.isNaN(num) && raw.trim() !== "") return num;
  return raw;
}

/**
 * Read an app's appbay.yaml as a parsed object.
 */
export async function getAppConfig(
  appbayHome: string,
  appName: string,
): Promise<{ config: Record<string, unknown>; path: string } | null> {
  const yamlPath = join(appbayHome, "etc", "apps", appName, "appbay.yaml");
  if (!existsSync(yamlPath)) return null;

  const raw = await readFile(yamlPath, "utf-8");
  const doc = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  return { config: doc, path: yamlPath };
}

/**
 * Get a specific config value by dotted key path.
 */
export async function getAppConfigValue(
  appbayHome: string,
  appName: string,
  key: string,
): Promise<{ value: unknown; found: boolean }> {
  const result = await getAppConfig(appbayHome, appName);
  if (!result) return { value: undefined, found: false };

  const value = getByPath(result.config, key);
  return { value, found: value !== undefined };
}

/**
 * Set a config value in an app's appbay.yaml.
 */
export async function setAppConfigValue(
  appbayHome: string,
  appName: string,
  key: string,
  value: string,
): Promise<{ path: string }> {
  const yamlPath = join(appbayHome, "etc", "apps", appName, "appbay.yaml");

  let doc: Record<string, unknown> = {};
  try {
    const raw = await readFile(yamlPath, "utf-8");
    doc = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  } catch {
    // New file
  }

  setByPath(doc, key, coerceValue(value));
  await writeFile(yamlPath, stringifyYaml(doc), "utf-8");
  return { path: yamlPath };
}

// ---------------------------------------------------------------------------
// Environment files (.env)
// ---------------------------------------------------------------------------

/**
 * Parse a .env file into a Map of key-value pairs.
 */
export function parseEnvFile(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      vars.set(trimmed.substring(0, eq), trimmed.substring(eq + 1));
    }
  }
  return vars;
}

/**
 * Serialize a Map of key-value pairs into .env file content.
 */
export function serializeEnv(vars: Map<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of vars) {
    lines.push(`${k}=${v}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Read an app's merged env view: .env (upstream defaults) + .env.local (user overrides).
 *
 * Returns the merged map (env.local wins), plus separate maps for each source
 * so the UI can show which values are overridden.
 */
export async function getAppEnv(
  appbayHome: string,
  appName: string,
): Promise<{
  vars: Map<string, string>;
  path: string;
  upstream: Map<string, string>;
  overrides: Map<string, string>;
  overridePath: string;
}> {
  const appDir = join(appbayHome, "etc", "apps", appName);
  const envPath = join(appDir, ".env");
  const localPath = join(appDir, ".env.local");

  let envContent = "";
  try { envContent = await readFile(envPath, "utf-8"); } catch { /* doesn't exist */ }

  let localContent = "";
  try { localContent = await readFile(localPath, "utf-8"); } catch { /* doesn't exist */ }

  const upstream = parseEnvFile(envContent);
  const overrides = parseEnvFile(localContent);

  // Merged view: upstream defaults + user overrides (overrides win)
  const merged = new Map(upstream);
  for (const [k, v] of overrides) {
    merged.set(k, v);
  }

  return { vars: merged, path: envPath, upstream, overrides, overridePath: localPath };
}

/**
 * Set an environment variable in .env.local (user overrides).
 * Never writes to the frozen upstream .env file.
 */
export async function setAppEnvVar(
  appbayHome: string,
  appName: string,
  key: string,
  value: string,
): Promise<void> {
  const appDir = join(appbayHome, "etc", "apps", appName);
  const localPath = join(appDir, ".env.local");

  let existing = new Map<string, string>();
  try {
    const content = await readFile(localPath, "utf-8");
    existing = parseEnvFile(content);
  } catch { /* doesn't exist yet */ }

  existing.set(key, value);
  await writeFile(localPath, serializeEnv(existing));
}

/**
 * Delete an environment variable from .env.local.
 * Never modifies the frozen upstream .env file.
 */
export async function deleteAppEnvVar(
  appbayHome: string,
  appName: string,
  key: string,
): Promise<boolean> {
  const appDir = join(appbayHome, "etc", "apps", appName);
  const localPath = join(appDir, ".env.local");

  let existing = new Map<string, string>();
  try {
    const content = await readFile(localPath, "utf-8");
    existing = parseEnvFile(content);
  } catch { return false; }

  if (!existing.has(key)) return false;
  existing.delete(key);
  await writeFile(localPath, serializeEnv(existing));
  return true;
}
