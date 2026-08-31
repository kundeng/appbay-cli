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

/**
 * A name claimed by more than one catalog, resolved in favour of an added source.
 *
 * Surfaced rather than silent: an operator who added a source that quietly replaced a
 * shipped app has no way to know it happened, and the two definitions can differ in ways
 * that matter — see RFC-001 §6.2, where upstream's `litellm` and the UOM one disagree about
 * whether the provider credential is a `required_input`.
 */
export interface CatalogOverride {
  name: string;
  /** The added source that won. */
  source: string;
  sourceDir: string;
  /** The bundled entry it shadowed. */
  shadowedDir: string;
}

/**
 * Two entries whose names differ only by hyphens, underscores or case — `open-webui` and
 * `openwebui`. Not a collision (both resolve, neither is lost), so it is neither an error nor
 * an override; it is an ambiguity the operator should know about, because typing the wrong
 * one silently installs a different definition of the same software.
 */
export interface CatalogNearDuplicate {
  /** The shared normalized key, e.g. `openwebui`. */
  normalized: string;
  entries: Array<{ name: string; source: string; dir: string }>;
}

export interface CatalogDiscoveryResult {
  entries: DiscoveredCatalogEntry[];
  errors: CatalogDiscoveryError[];
  /** Names where an added source overrode `bundled`. Empty on a stock install. */
  overrides: CatalogOverride[];
  /** Names that differ only by punctuation or case. See {@link CatalogNearDuplicate}. */
  nearDuplicates: CatalogNearDuplicate[];
}

/**
 * Fold a catalog name to the key used for near-duplicate detection.
 *
 * Deliberately narrow — case plus `-`/`_` only, no stemming or edit distance. Measured over
 * all 155 entries in the shipped catalog plus the UOM stack, this rule produces exactly ONE
 * group (`open-webui` / `openwebui`), which is the real case RFC-001 §6.7 names. A looser
 * rule would fire across a 150-app catalog and the warning would be ignored.
 */
function normalizeCatalogName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
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

  // Deduplicate. Three different collisions live here and they have three different right
  // answers; the previous rule was the single expression `!existing || source === "bundled"`,
  // which collapsed them into "bundled always wins" and left nowhere to report anything.
  //
  //   bundled vs source   → the SOURCE wins. Adding a source is an explicit act; shipping
  //                         one is not. Recorded in `overrides` so it is never silent.
  //   source  vs source   → ambiguous. Previously decided by readdir() order, i.e. undefined.
  //                         Now an error naming both directories, and the name resolves to
  //                         nothing rather than to a coin flip.
  //   bundled vs bundled  → one catalog shipping two entries under one name. A packaging
  //                         bug; error naming both directories.
  //
  // RFC-001 §6.2, §6.5, §6.6. Dedup keys on the `name` declared inside catalog.yaml, not on
  // the directory name — so every message names the directory, or it is unactionable.
  const seen = new Map<string, DiscoveredCatalogEntry>();
  const overrides: CatalogOverride[] = [];
  const ambiguous = new Set<string>();

  for (const entry of entries) {
    const existing = seen.get(entry.name);
    if (!existing) {
      seen.set(entry.name, entry);
      continue;
    }

    const existingIsBundled = existing.source === "bundled";
    const entryIsBundled = entry.source === "bundled";

    if (existingIsBundled && !entryIsBundled) {
      overrides.push({
        name: entry.name,
        source: entry.source,
        sourceDir: entry.dir,
        shadowedDir: existing.dir,
      });
      seen.set(entry.name, entry);
    } else if (!existingIsBundled && entryIsBundled) {
      // `bundled` is scanned first so this order should be unreachable, but the rule is
      // stated by precedence and not by scan order — otherwise it is one refactor from wrong.
      overrides.push({
        name: existing.name,
        source: existing.source,
        sourceDir: existing.dir,
        shadowedDir: entry.dir,
      });
    } else if (existingIsBundled && entryIsBundled) {
      errors.push({
        dir: entry.dir,
        message:
          `Duplicate name "${entry.name}" in the bundled catalog: ` +
          `${existing.dir} and ${entry.dir} both declare it. One of them must be renamed.`,
      });
      ambiguous.add(entry.name);
    } else {
      errors.push({
        dir: entry.dir,
        message:
          `Catalog name collision: "${entry.name}" is declared by source "${existing.source}" ` +
          `(${existing.dir}) and source "${entry.source}" (${entry.dir}). Two added sources ` +
          `cannot claim one name — remove or rename one. Until then "${entry.name}" resolves ` +
          `to neither.`,
      });
      ambiguous.add(entry.name);
    }
  }

  for (const name of ambiguous) seen.delete(name);

  const deduped = Array.from(seen.values());
  deduped.sort((a, b) => a.name.localeCompare(b.name));

  // RFC-001 §6.7. Run AFTER dedup, so a name that lost a collision is not also reported as a
  // near-duplicate of the winner — that would be one confusing event described twice.
  const byNormalized = new Map<string, DiscoveredCatalogEntry[]>();
  for (const entry of deduped) {
    const key = normalizeCatalogName(entry.name);
    const bucket = byNormalized.get(key);
    if (bucket) bucket.push(entry);
    else byNormalized.set(key, [entry]);
  }

  const nearDuplicates: CatalogNearDuplicate[] = [];
  for (const [normalized, bucket] of byNormalized) {
    if (new Set(bucket.map((e) => e.name)).size < 2) continue;
    nearDuplicates.push({
      normalized,
      entries: bucket.map((e) => ({ name: e.name, source: e.source, dir: e.dir })),
    });
  }

  return { entries: deduped, errors, overrides, nearDuplicates };
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
