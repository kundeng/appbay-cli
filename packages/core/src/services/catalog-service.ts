import { readdir, readFile, stat, mkdir, cp, rm, writeFile, chmod } from "node:fs/promises";
// Config files are small and read on paths that are already synchronous elsewhere in core.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { discoverCatalog, type DiscoveredCatalogEntry } from "../catalog/discover.js";
import type { CatalogEntry, RequiredInput } from "../schemas/catalog.js";
import { readInstanceConfigText } from "../schemas/instance.js";

export interface InstallOptions {
  appbayHome: string;
  name: string;
  values?: Record<string, string>;
  force?: boolean;
}

export interface InstallResult {
  success: boolean;
  appDir: string;
  message: string;
  requiredInputs?: RequiredInput[];
  secretsWired?: string[];
}

export async function catalogList(
  appbayHome: string,
  filters?: { source?: string; readiness?: string; category?: string; query?: string },
) {
  const { entries, errors } = await discoverCatalog(appbayHome);

  let filtered = entries;
  if (filters?.source) {
    filtered = filtered.filter((e) => e.source === filters.source);
  }
  if (filters?.readiness) {
    filtered = filtered.filter((e) => e.entry.readiness === filters.readiness);
  }
  if (filters?.category) {
    filtered = filtered.filter((e) => e.entry.category === filters.category);
  }
  if (filters?.query) {
    const q = filters.query.toLowerCase();
    filtered = filtered.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.entry.description.toLowerCase().includes(q) ||
        e.entry.category.toLowerCase().includes(q) ||
        e.entry.tags.some((t: string) => t.toLowerCase().includes(q)),
    );
  }

  return { entries: filtered, errors };
}

export async function catalogGet(
  appbayHome: string,
  name: string,
): Promise<{ entry: DiscoveredCatalogEntry; appbayYaml: string | null } | null> {
  const { entries } = await discoverCatalog(appbayHome);
  const match = entries.find((e) => e.name === name);
  if (!match) return null;

  let appbayYaml: string | null = null;
  try {
    appbayYaml = await readFile(join(match.dir, "appbay.yaml"), "utf-8");
  } catch {
    // No appbay.yaml
  }

  return { entry: match, appbayYaml };
}

/**
 * Install a catalog app.
 *
 * Follows the upstream model: frozen compose + frozen .env + appbay.yaml overlay.
 *
 * For secrets (type: secret with auto_generate):
 *   - Wires a secrets trait into appbay.yaml with vault://<app>/<KEY>?gen=password:32
 *   - On first `appbay up`, the vault auto-generates and stores the value
 *   - The upstream .env stays unchanged — process env injection overrides at runtime
 *
 * For user-provided secrets (type: secret without auto_generate):
 *   - Stores in vault via the vault service
 *   - Wires into secrets trait the same way
 *
 * For non-secret config (type: string):
 *   - Writes to .env.local (override file, NOT the upstream .env)
 *   - Only values that differ from the upstream default
 *
 * The upstream .env and docker-compose.yml are NEVER modified.
 */
export async function catalogInstall(options: InstallOptions): Promise<InstallResult> {
  const { appbayHome, name, values = {}, force = false } = options;
  const appsDir = join(appbayHome, "etc", "apps");
  const targetDir = join(appsDir, name);

  // Check if already installed
  try {
    await stat(targetDir);
    if (!force) {
      return {
        success: false,
        appDir: targetDir,
        message: `App "${name}" already installed. Use force to overwrite.`,
      };
    }
  } catch {
    // Not installed
  }

  // Find in catalog
  const { entries } = await discoverCatalog(appbayHome);
  const match = entries.find((e) => e.name === name);
  if (!match) {
    return {
      success: false,
      appDir: targetDir,
      message: `App "${name}" not found in catalog.`,
    };
  }

  // Check for missing required inputs (user-provided secrets without auto-gen)
  const missing = match.entry.required_inputs.filter(
    (input) =>
      !(input.name in values) &&
      input.default === undefined &&
      !(input.type === "secret" && input.auto_generate),
  );

  if (missing.length > 0) {
    return {
      success: false,
      appDir: targetDir,
      message: "Missing required inputs.",
      requiredInputs: match.entry.required_inputs,
    };
  }

  // Copy catalog entry (frozen upstream files + appbay.yaml)
  if (force) {
    await rm(targetDir, { recursive: true, force: true });
  }
  await mkdir(targetDir, { recursive: true });
  await cp(match.dir, targetDir, { recursive: true });

  // Remove catalog.yaml from installed copy but save as config-schema
  // (the GUI reads config-schema.yaml to render typed form fields)
  try {
    const catalogContent = await readFile(join(targetDir, "catalog.yaml"), "utf-8");
    await writeFile(join(targetDir, "config-schema.yaml"), catalogContent);
    await rm(join(targetDir, "catalog.yaml"));
  } catch {
    // No catalog.yaml
  }

  // Read vars from installed appbay.yaml (authoritative for UI-configurable variables)
  // Falls back to catalog.yaml required_inputs for entries not yet migrated to vars:
  const appbayYamlPath = join(targetDir, "appbay.yaml");
  let varDefs: Array<{ name: string; type: string; default?: string | number | boolean; auto_generate?: boolean }> = [];

  try {
    const appbayContent = await readFile(appbayYamlPath, "utf-8");
    const parsed = parseYaml(appbayContent) as Record<string, unknown>;
    const vars = parsed.vars as Record<string, Record<string, unknown>> | undefined;
    if (vars && typeof vars === "object") {
      varDefs = Object.entries(vars).map(([varName, def]) => ({
        name: varName,
        type: String(def.type ?? "string"),
        default: def.default as string | number | boolean | undefined,
        auto_generate: def.auto_generate as boolean | undefined,
      }));
    }
  } catch { /* no appbay.yaml or no vars */ }

  // Fall back to catalog.yaml required_inputs if vars: is empty
  if (varDefs.length === 0) {
    varDefs = match.entry.required_inputs.map((i) => ({
      name: i.name,
      type: i.type,
      default: i.default,
      auto_generate: i.auto_generate,
    }));
  }

  const secretInputs = varDefs.filter((i) => i.type === "secret");
  const configInputs = varDefs.filter((i) => i.type !== "secret");

  // Wire secrets into vault
  const secretsWired: string[] = [];
  // Secrets the vault could not take. They are written to .env.local instead — see the
  // comment on the catch below for why the reference must NOT stay pointed at the vault.
  const fallbackSecrets: string[] = [];

  if (secretInputs.length > 0) {
    const refs: Record<string, string> = {};

    for (const input of secretInputs) {
      if (input.auto_generate) {
        refs[input.name] = `vault://${name}/${input.name}?gen=password:32`;
        secretsWired.push(`${input.name} (auto-generate on first deploy)`);
      } else if (input.name in values) {
        try {
          const { setSecret } = await import("./vault-service.js");
          await setSecret(appbayHome, `${name}/${input.name}`, values[input.name]);
          // 🚨 ONLY on success. This assignment used to happen BEFORE the try, so a vault
          // failure left `vault://<app>/<name>` in the manifest pointing at a value the
          // vault never took — and `appbay up` died with "Vault password required" on an
          // app the installer had just called ready to deploy.
          refs[input.name] = `vault://${name}/${input.name}`;
          secretsWired.push(`${input.name} (stored in vault)`);
        } catch {
          // 🚨 THE FALLBACK IS NOW PERFORMED, NOT MERELY ANNOUNCED (issue #47).
          //
          // This branch used to push the string "(vault unavailable, written to
          // .env.local)" and write nothing at all — measured 2026-08-16 with a non-empty
          // value, so it was not an empty-value edge case. The install reported success,
          // validation passed, and the app was undeployable.
          //
          // ⚠️ This puts the secret on disk in PLAINTEXT, which is a real downgrade from
          // the AES-256-GCM vault. It is announced as such rather than described as
          // ordinary wiring, because the user did not choose it — the vault being locked
          // did.
          fallbackSecrets.push(`${input.name}=${values[input.name]}`);
          secretsWired.push(
            `${input.name} (VAULT UNAVAILABLE — written to .env.local in PLAINTEXT; ` +
              `run \`appbay secrets init\` then \`appbay secrets set ${name}/${input.name}\` ` +
              `to move it into the vault)`,
          );
        }
      }
    }

    if (Object.keys(refs).length > 0) {
      await addSecretsTrait(join(targetDir, "appbay.yaml"), refs);
    }
  }

  // Write non-secret config overrides to .env.local (NOT the upstream .env)
  const projectVars = await loadProjectVars(appbayHome);
  const configOverrides: string[] = [];

  for (const input of configInputs) {
    if (input.name in values) {
      configOverrides.push(`${input.name}=${resolveScopedVars(values[input.name], projectVars)}`);
    } else if (input.default !== undefined) {
      configOverrides.push(`${input.name}=${resolveScopedVars(String(input.default), projectVars)}`);
    }
  }

  if (configOverrides.length > 0 || fallbackSecrets.length > 0) {
    const envLocalPath = join(targetDir, ".env.local");
    let body = "# Appbay config overrides (non-secret values set at install time)\n";
    if (configOverrides.length > 0) body += configOverrides.join("\n") + "\n";
    if (fallbackSecrets.length > 0) {
      body +=
        "\n# ⚠️ PLAINTEXT SECRETS. The vault was unavailable at install time, so these\n" +
        "# were written here instead. Move them into the vault with `appbay secrets init`\n" +
        "# followed by `appbay secrets set <app>/<NAME>`, then delete these lines.\n" +
        fallbackSecrets.join("\n") + "\n";
    }
    await writeFile(envLocalPath, body);
    // 0600 whenever this file holds a secret — it is otherwise created world-readable by
    // whatever the process umask happens to be.
    if (fallbackSecrets.length > 0) {
      await chmod(envLocalPath, 0o600);
    }
  }

  return {
    success: true,
    appDir: targetDir,
    message: `Installed ${name} to ${targetDir}`,
    secretsWired,
  };
}

/**
 * Add or merge a secrets trait into an existing appbay.yaml.
 */
async function addSecretsTrait(
  appbayPath: string,
  refs: Record<string, string>,
): Promise<void> {
  let config: Record<string, unknown> = {};
  try {
    const raw = await readFile(appbayPath, "utf-8");
    config = (parseYaml(raw) as Record<string, unknown>) ?? {};
  } catch {
    // No existing appbay.yaml — create one
  }

  const traits = (config.traits ?? []) as Array<Record<string, unknown>>;

  // Find existing secrets trait or create new one
  const existing = traits.find((t) => t.type === "secrets");
  if (existing) {
    const existingRefs = (existing.refs ?? {}) as Record<string, string>;
    existing.refs = { ...existingRefs, ...refs };
  } else {
    traits.push({
      type: "secrets",
      provider: "vault",
      refs,
      injection: "runtime-env",
    });
  }

  config.traits = traits;
  await writeFile(appbayPath, stringifyYaml(config, { sortMapEntries: false }));
}

// ---------------------------------------------------------------------------
// Source management
// ---------------------------------------------------------------------------

interface CatalogSourceConfig {
  sources: Array<{ name: string; url: string; added: string }>;
}

async function loadSourcesConfig(appbayHome: string): Promise<CatalogSourceConfig> {
  const configPath = join(appbayHome, "etc", "catalog-sources.yaml");
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = parseYaml(raw) as CatalogSourceConfig;
    return { sources: parsed?.sources ?? [] };
  } catch {
    return { sources: [] };
  }
}

async function saveSourcesConfig(appbayHome: string, config: CatalogSourceConfig): Promise<void> {
  const configPath = join(appbayHome, "etc", "catalog-sources.yaml");
  await mkdir(join(appbayHome, "etc"), { recursive: true });
  await writeFile(configPath, stringifyYaml(config), "utf-8");
}

/** True when `path` names an existing directory — i.e. a local catalog rather than a URL. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function catalogAddSource(
  appbayHome: string,
  name: string,
  url: string,
): Promise<{ success: boolean; message: string; entryCount?: number }> {
  const sourcesDir = join(appbayHome, "var", "lib", "catalog", "sources");
  const targetDir = join(sourcesDir, name);

  try {
    await stat(targetDir);
    return { success: false, message: `Source "${name}" already exists at ${targetDir}` };
  } catch {
    // Good
  }

  await mkdir(sourcesDir, { recursive: true });

  // A source may be a LOCAL DIRECTORY, not only a git URL. RFC-001 §6.1 makes
  // `appbay init --catalog <path>` equivalent to adding a source, and the consuming
  // project passes a path (`provision-appbay.yml`: `--catalog /app/llm-stack-catalog`),
  // so a clone-only implementation would reject exactly the caller that needs this.
  // Symlink so `catalog update-source` and an out-of-band edit both stay live; copy when
  // the filesystem refuses a link.
  if (await isDirectory(url)) {
    try {
      const { symlink } = await import("node:fs/promises");
      await symlink(url, targetDir);
    } catch {
      await mkdir(targetDir, { recursive: true });
      await cp(url, targetDir, { recursive: true });
    }
  } else {
    const result = spawnSync("git", ["clone", "--depth", "1", url, targetDir], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    });

    if (result.status !== 0) {
      const err = result.stderr ? String(result.stderr).trim() : "unknown error";
      return { success: false, message: `Failed to clone: ${err}` };
    }
  }

  let entryCount = 0;
  try {
    const dirEntries = await readdir(targetDir);
    for (const entry of dirEntries) {
      try {
        const info = await stat(join(targetDir, entry, "catalog.yaml"));
        if (info.isFile()) entryCount++;
      } catch { /* not a catalog entry */ }
    }
  } catch { /* can't read dir */ }

  const config = await loadSourcesConfig(appbayHome);
  config.sources = config.sources.filter((s) => s.name !== name);
  config.sources.push({ name, url, added: new Date().toISOString().slice(0, 10) });
  await saveSourcesConfig(appbayHome, config);

  return {
    success: true,
    message: `Added source "${name}" from ${url} (${entryCount} entries)`,
    entryCount,
  };
}

export async function catalogUpdateSource(
  appbayHome: string,
  sourceName?: string,
): Promise<Array<{ name: string; success: boolean; message: string }>> {
  const config = await loadSourcesConfig(appbayHome);
  const sourcesDir = join(appbayHome, "var", "lib", "catalog", "sources");
  const results: Array<{ name: string; success: boolean; message: string }> = [];

  const toUpdate = sourceName
    ? config.sources.filter((s) => s.name === sourceName)
    : config.sources;

  if (toUpdate.length === 0) {
    return [{ name: sourceName ?? "*", success: false, message: "No sources configured" }];
  }

  for (const source of toUpdate) {
    const sourceDir = join(sourcesDir, source.name);
    const result = spawnSync("git", ["-C", sourceDir, "pull", "--ff-only"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    });

    if (result.status === 0) {
      const output = String(result.stdout).trim();
      results.push({
        name: source.name,
        success: true,
        message: output.includes("Already up to date") ? "Already up to date" : "Updated",
      });
    } else {
      results.push({
        name: source.name,
        success: false,
        message: String(result.stderr).trim() || "git pull failed",
      });
    }
  }

  return results;
}

export async function catalogListSources(
  appbayHome: string,
): Promise<Array<{ name: string; url: string; added: string; entryCount: number }>> {
  const config = await loadSourcesConfig(appbayHome);
  const sourcesDir = join(appbayHome, "var", "lib", "catalog", "sources");
  const results: Array<{ name: string; url: string; added: string; entryCount: number }> = [];

  const bundledDir = join(appbayHome, "var", "lib", "catalog", "bundled");
  let bundledCount = 0;
  try {
    const dirEntries = await readdir(bundledDir);
    for (const entry of dirEntries) {
      try {
        await stat(join(bundledDir, entry, "catalog.yaml"));
        bundledCount++;
      } catch { /* not a catalog entry */ }
    }
  } catch { /* no bundled dir */ }
  results.push({ name: "bundled", url: "(built-in)", added: "-", entryCount: bundledCount });

  for (const source of config.sources) {
    let entryCount = 0;
    try {
      const dirEntries = await readdir(join(sourcesDir, source.name));
      for (const entry of dirEntries) {
        try {
          await stat(join(sourcesDir, source.name, entry, "catalog.yaml"));
          entryCount++;
        } catch { /* not a catalog entry */ }
      }
    } catch { /* dir missing */ }
    results.push({ name: source.name, url: source.url, added: source.added, entryCount });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadProjectVars(home: string): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
  try {
    const raw =
      readInstanceConfigText(home, (p) => readFileSync(p, "utf-8")) ?? "";
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") vars[k.toUpperCase()] = v;
      }
    }
  } catch {
    // No project config
  }
  return vars;
}

function resolveScopedVars(value: string, projectVars: Record<string, string>): string {
  return value.replace(/\$\{\{project\.(\w+)\}\}/g, (_match, key: string) => {
    return projectVars[key.toUpperCase()] ?? `\${${key}}`;
  });
}
