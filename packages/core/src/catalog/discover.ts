import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CatalogEntrySchema, type CatalogEntry } from "../schemas/catalog.js";

const CATALOG_YAML = "catalog.yaml";

export interface CatalogDiscoverOptions {
  catalogDir: string;
}

export interface DiscoveredCatalogEntry {
  name: string;
  dir: string;
  entry: CatalogEntry;
  source: "bundled" | string;
  hasAppbayYaml: boolean;
  hasCompose: boolean;
}

export interface CatalogDiscoveryError {
  dir: string;
  message: string;
  details?: unknown;
}

export interface CatalogDiscoveryResult {
  entries: DiscoveredCatalogEntry[];
  errors: CatalogDiscoveryError[];
}

export async function discoverCatalog(
  appbayHome: string,
): Promise<CatalogDiscoveryResult> {
  const catalogRoot = join(appbayHome, "var", "lib", "catalog");
  const entries: DiscoveredCatalogEntry[] = [];
  const errors: CatalogDiscoveryError[] = [];

  const bundledDir = join(catalogRoot, "bundled");
  await scanCatalogSource(bundledDir, "bundled", entries, errors);

  const sourcesDir = join(catalogRoot, "sources");
  try {
    const sources = await readdir(sourcesDir);
    for (const sourceName of sources) {
      const sourceDir = join(sourcesDir, sourceName);
      const info = await stat(sourceDir).catch(() => null);
      if (!info?.isDirectory()) continue;
      await scanCatalogSource(sourceDir, sourceName, entries, errors);
    }
  } catch {
    // No sources dir — that's fine
  }

  // Deduplicate: bundled wins on name collision
  const seen = new Map<string, DiscoveredCatalogEntry>();
  for (const entry of entries) {
    const existing = seen.get(entry.name);
    if (!existing || entry.source === "bundled") {
      seen.set(entry.name, entry);
    }
  }

  const deduped = Array.from(seen.values());
  deduped.sort((a, b) => a.name.localeCompare(b.name));

  return { entries: deduped, errors };
}

async function scanCatalogSource(
  sourceDir: string,
  sourceName: string,
  entries: DiscoveredCatalogEntry[],
  errors: CatalogDiscoveryError[],
): Promise<void> {
  let dirEntries: string[];
  try {
    dirEntries = await readdir(sourceDir);
  } catch {
    return;
  }

  for (const name of dirEntries) {
    const appDir = join(sourceDir, name);
    const info = await stat(appDir).catch(() => null);
    if (!info?.isDirectory()) continue;

    const catalogPath = join(appDir, CATALOG_YAML);
    let raw: string;
    try {
      raw = await readFile(catalogPath, "utf-8");
    } catch {
      continue; // No catalog.yaml — skip
    }

    try {
      const parsed = parseYaml(raw);
      const result = CatalogEntrySchema.safeParse(parsed);
      if (!result.success) {
        errors.push({
          dir: appDir,
          message: `Invalid ${CATALOG_YAML}: ${result.error.issues.map((i) => i.message).join(", ")}`,
          details: result.error.issues,
        });
        continue;
      }

      const hasAppbayYaml = await fileExists(join(appDir, "appbay.yaml"));
      const hasCompose = await hasComposeFile(appDir);

      entries.push({
        name: result.data.name,
        dir: appDir,
        entry: result.data,
        source: sourceName,
        hasAppbayYaml,
        hasCompose,
      });
    } catch (err) {
      errors.push({
        dir: appDir,
        message: `Failed to parse ${CATALOG_YAML}: ${err instanceof Error ? err.message : String(err)}`,
        details: err,
      });
    }
  }
}

const COMPOSE_NAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

async function hasComposeFile(dir: string): Promise<boolean> {
  for (const name of COMPOSE_NAMES) {
    if (await fileExists(join(dir, name))) return true;
  }
  return false;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}
