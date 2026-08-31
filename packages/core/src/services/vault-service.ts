/**
 * Vault service — business logic for local secret vault management.
 *
 * Extracts vault CRUD, initialization, scanning, and password resolution
 * from the CLI into reusable typed functions. Both CLI commands and tRPC
 * routers call these functions — "one API, two interfaces."
 *
 * Two separate secret stores, each with its own URI scheme:
 *   - vault://  → AES-256-GCM encrypted JSON at $APPBAY_HOME/var/lib/vault.enc
 *   - keepass:// → KeePass .kdbx file at $APPBAY_HOME/var/lib/secrets.kdbx
 *
 * The two stores are independent. Users choose which scheme to use in their
 * appbay.yaml secrets trait refs. No "backend" config that makes one
 * polymorphic over the other.
 *
 * All functions take `appbayHome` as an explicit parameter so callers
 * control path resolution (CLI uses its own resolver, web uses env var).
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { Vault } from "../secrets/providers/vault.js";
import { runKeepassxc, stdinLines } from "../secrets/keepassxc-cli.js";
import { discoverApps, type DiscoveredApp } from "../compiler/index.js";
import {
  resolveMasterPassword,
  persistMasterPassword,
  MASTER_PASSWORD_REL,
} from "../secrets/master-password.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VaultInitResult {
  vaultPath: string;
  passwordPath: string;
  generated: boolean;
}

export interface KdbxInitResult {
  dbPath: string;
  passwordPath: string;
  generated: boolean;
}

export interface VaultSetResult {
  key: string;
  scope: string;
  uri: string;
}

export interface VaultRotateResult {
  vaultPath: string;
  passwordPath: string;
  entries: number;
  generated: boolean;
}

export interface VaultEntry {
  key: string;
  scope: string;
}

export interface VaultListResult {
  entries: VaultEntry[];
  total: number;
  /** Entries grouped by scope. */
  byScope: Record<string, string[]>;
}

export interface ScannedVar {
  key: string;
  value: string;
  source: "compose" | "env" | "env-template";
  service?: string;
  looksSecret: boolean;
  isPlaceholder: boolean;
  hasVaultRef: boolean;
}

export interface ScanResult {
  appName: string;
  vars: ScannedVar[];
  secrets: ScannedVar[];
  unmanaged: ScannedVar[];
}

// ---------------------------------------------------------------------------
// Vault password resolution
// ---------------------------------------------------------------------------

/**
 * @deprecated Call `resolveMasterPassword` directly. Kept so existing callers keep compiling.
 *
 * RFC-001 §2.2: one password opens whichever store the installation uses, resolved in one
 * place. This and `resolveKdbxPassword` were separate two- and four-tier ladders; they are
 * now the same function under two names.
 */
export function resolveVaultPassword(appbayHome: string): string {
  return resolveMasterPassword(appbayHome);
}

// ---------------------------------------------------------------------------
// KeePass password resolution
// ---------------------------------------------------------------------------

/** @deprecated Call `resolveMasterPassword` directly — see `resolveVaultPassword`. */
export function resolveKdbxPassword(appbayHome: string): string {
  return resolveMasterPassword(appbayHome);
}

/**
 * Resolve the conventional path to the KeePass database file.
 */
export function resolveKdbxPath(appbayHome: string): string {
  if (process.env.APPBAY_KEEPASS_DB) {
    return process.env.APPBAY_KEEPASS_DB;
  }
  return join(appbayHome, "var", "lib", "secrets.kdbx");
}

// ---------------------------------------------------------------------------
// Vault CRUD operations (vault.enc — AES-256-GCM)
// ---------------------------------------------------------------------------

/**
 * Initialize the local secrets vault (AES-256-GCM encrypted JSON).
 *
 * Creates the vault file and stores the master password. If no password is
 * provided, auto-generates one. No-op if vault already exists.
 */
export function initVault(
  appbayHome: string,
  password?: string,
): VaultInitResult {
  const vaultPath = join(appbayHome, "var", "lib", "vault.enc");
  const passwordFilePath = join(appbayHome, MASTER_PASSWORD_REL);

  if (existsSync(vaultPath)) {
    return { vaultPath, passwordPath: passwordFilePath, generated: false };
  }

  // ⚠️ Writes to var/lib/secrets/master-password, NOT etc/vault-password. RFC-001 §2.2
  // consolidates the credential; reads still fall back to the legacy path for one release,
  // but a resolver that prefers the new location while writes go to the old one improves
  // nothing. An existing install keeps working because the fallback finds its old file.
  const generated = password === undefined && !process.env.APPBAY_MASTER_PASSWORD;
  const finalPassword = persistMasterPassword(
    appbayHome,
    password ?? process.env.APPBAY_MASTER_PASSWORD ?? undefined,
  );

  // Create the vault (write+delete a sentinel to force file creation)
  mkdirSync(join(appbayHome, "var", "lib"), { recursive: true });
  const vault = new Vault(vaultPath, finalPassword);
  vault.set("_init", "true");
  vault.delete("_init");

  return { vaultPath, passwordPath: passwordFilePath, generated };
}

/**
 * Re-encrypt the local vault with a new master password.
 *
 * The old password is resolved using the normal precedence. A complete new vault
 * is written and reopened before either live file is replaced. The old vault is
 * restored if replacing the password file fails, so callers never receive a
 * successful result with an unreadable local vault.
 */
export function rotateVaultPassword(
  appbayHome: string,
  newPassword?: string,
): VaultRotateResult {
  const vaultPath = join(appbayHome, "var", "lib", "vault.enc");
  const passwordPath = join(appbayHome, "etc", "vault-password");

  if (!existsSync(vaultPath)) {
    throw new Error("Vault not initialized. Run 'appbay secrets init' first.");
  }

  const oldPassword = resolveVaultPassword(appbayHome);
  const oldVault = new Vault(vaultPath, oldPassword);
  const entries = oldVault.listAll();
  const finalPassword = newPassword ?? randomBytes(24).toString("base64url");
  const generated = newPassword === undefined;
  const tempVaultPath = join(dirname(vaultPath), `.vault.rotate-${randomBytes(8).toString("hex")}`);
  const tempPasswordPath = join(dirname(passwordPath), `.vault-password.rotate-${randomBytes(8).toString("hex")}`);
  const oldVaultBytes = readFileSync(vaultPath);
  const oldPasswordBytes = existsSync(passwordPath) ? readFileSync(passwordPath) : null;

  try {
    const newVault = new Vault(tempVaultPath, finalPassword);
    for (const entry of entries) {
      const value = oldVault.get(entry.key, entry.scope);
      if (value === null) throw new Error(`Vault entry disappeared during rotation: ${entry.scope}/${entry.key}`);
      newVault.set(entry.key, value, entry.scope);
    }

    // Decrypting every entry through a fresh instance is the pre-commit check.
    const verifiedVault = new Vault(tempVaultPath, finalPassword);
    for (const entry of entries) {
      if (verifiedVault.get(entry.key, entry.scope) === null) {
        throw new Error(`Rotated vault verification failed for ${entry.scope}/${entry.key}`);
      }
    }

    mkdirSync(dirname(passwordPath), { recursive: true });
    writeFileSync(tempPasswordPath, finalPassword, { mode: 0o600 });
    try { chmodSync(tempPasswordPath, 0o600); } catch { /* filesystem may not support chmod */ }

    renameSync(tempVaultPath, vaultPath);
    try {
      renameSync(tempPasswordPath, passwordPath);
    } catch (error) {
      writeFileSync(vaultPath, oldVaultBytes);
      if (oldPasswordBytes === null) {
        try { unlinkSync(passwordPath); } catch { /* no prior password file */ }
      } else {
        writeFileSync(passwordPath, oldPasswordBytes, { mode: 0o600 });
      }
      throw error;
    }

    return { vaultPath, passwordPath, entries: entries.length, generated };
  } finally {
    try { unlinkSync(tempVaultPath); } catch { /* temporary vault was renamed or never created */ }
    try { unlinkSync(tempPasswordPath); } catch { /* temporary password was renamed or never created */ }
  }
}

/** Restore the local password file after independently verifying a vault password. */
export function repairVaultPasswordFile(appbayHome: string): { passwordPath: string } {
  const vaultPath = join(appbayHome, "var", "lib", "vault.enc");
  const passwordPath = join(appbayHome, "etc", "vault-password");
  if (!existsSync(vaultPath)) {
    throw new Error("Vault not initialized. Run 'appbay secrets init' first.");
  }

  const password = resolveVaultPassword(appbayHome);
  // Constructing the vault proves the candidate password authenticates the vault.
  new Vault(vaultPath, password);
  mkdirSync(dirname(passwordPath), { recursive: true });
  const tempPath = join(dirname(passwordPath), `.vault-password.repair-${randomBytes(8).toString("hex")}`);
  try {
    writeFileSync(tempPath, password, { mode: 0o600 });
    try { chmodSync(tempPath, 0o600); } catch { /* filesystem may not support chmod */ }
    renameSync(tempPath, passwordPath);
  } finally {
    try { unlinkSync(tempPath); } catch { /* temporary file was renamed or never created */ }
  }
  return { passwordPath };
}

/**
 * Store a secret in the vault.
 *
 * Key format: "KEY" → scope=default, "APP/KEY" → scope=APP.
 */
export function setSecret(
  appbayHome: string,
  keyArg: string,
  value: string,
): VaultSetResult {
  const vaultPath = join(appbayHome, "var", "lib", "vault.enc");
  const password = resolveVaultPassword(appbayHome);

  const parts = keyArg.split("/");
  const key = parts[parts.length - 1];
  const scope = parts.length > 1 ? parts.slice(0, -1).join("/") : "default";

  const vault = new Vault(vaultPath, password);
  vault.set(key, value, scope);

  return {
    key,
    scope,
    uri: `vault://${scope === "default" ? key : `${scope}/${key}`}`,
  };
}

/**
 * Retrieve a secret from the vault. Returns null if not found.
 */
export function getSecret(
  appbayHome: string,
  keyArg: string,
): string | null {
  const vaultPath = join(appbayHome, "var", "lib", "vault.enc");

  if (!existsSync(vaultPath)) {
    throw new Error("Vault not initialized. Run 'appbay secrets init' first.");
  }

  const password = resolveVaultPassword(appbayHome);
  const parts = keyArg.split("/");
  const key = parts[parts.length - 1];
  const scope = parts.length > 1 ? parts.slice(0, -1).join("/") : "default";

  const vault = new Vault(vaultPath, password);
  return vault.get(key, scope);
}

/**
 * Delete a secret from the vault. Returns true if it existed.
 */
export function deleteSecret(
  appbayHome: string,
  keyArg: string,
): { deleted: boolean; key: string; scope: string } {
  const vaultPath = join(appbayHome, "var", "lib", "vault.enc");

  if (!existsSync(vaultPath)) {
    throw new Error("Vault not initialized. Run 'appbay secrets init' first.");
  }

  const password = resolveVaultPassword(appbayHome);
  const parts = keyArg.split("/");
  const key = parts[parts.length - 1];
  const scope = parts.length > 1 ? parts.slice(0, -1).join("/") : "default";

  const vault = new Vault(vaultPath, password);
  const deleted = vault.delete(key, scope);

  return { deleted, key, scope };
}

/**
 * List secrets in the vault, optionally filtered by scope.
 */
export function listVaultSecrets(
  appbayHome: string,
  scope?: string,
): VaultListResult {
  const vaultPath = join(appbayHome, "var", "lib", "vault.enc");

  if (!existsSync(vaultPath)) {
    return { entries: [], total: 0, byScope: {} };
  }

  const password = resolveVaultPassword(appbayHome);
  const vault = new Vault(vaultPath, password);

  const entries = scope ? vault.list(scope) : vault.listAll();

  // Group by scope
  const byScope: Record<string, string[]> = {};
  for (const entry of entries) {
    const list = byScope[entry.scope] ?? [];
    list.push(entry.key);
    byScope[entry.scope] = list;
  }

  return { entries, total: entries.length, byScope };
}

// ---------------------------------------------------------------------------
// KeePass CRUD operations (.kdbx via keepassxc-cli)
// ---------------------------------------------------------------------------

/**
 * Check if keepassxc-cli is available on the system.
 */
export async function isKeePassCliAvailable(): Promise<boolean> {
  try {
    await runKeepassxc(["--version"], "", 5_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the keepassxc-cli version string, or null if not available.
 */
export async function getKeePassCliVersion(): Promise<string | null> {
  try {
    const { stdout } = await runKeepassxc(["--version"], "", 5_000);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Run a keepassxc-cli command with the database password piped via stdin.
 *
 * The name was already true of the intent and false of the implementation — it composed
 * `echo '<password>' | …` into a `/bin/sh -c` argv. Now it is true of both.
 *
 * `entryPassword` is for the `--password-prompt` commands (`add`, `edit`), which read a
 * second line: line 1 is the database password, line 2 is the entry's. Omit it for every
 * other command. Both values travel on stdin so neither reaches an argv.
 */
async function runKeePassCli(
  args: string[],
  password: string,
  entryPassword?: string,
  timeoutMs = 15_000,
): Promise<string> {
  const stdin =
    entryPassword === undefined
      ? stdinLines(password)
      : stdinLines(password, entryPassword);
  const { stdout } = await runKeepassxc(args, stdin, timeoutMs);
  return stdout.trim();
}

/**
 * Ensure keepassxc-cli is available, throwing a clear error if not.
 */
async function requireKeePassCli(): Promise<void> {
  if (!(await isKeePassCliAvailable())) {
    throw new Error(
      "keepassxc-cli not found. Install it: apt install keepassxc (or brew install keepassxc on macOS).",
    );
  }
}

/**
 * Initialize a KeePass .kdbx database file.
 *
 * Creates the .kdbx file at `$APPBAY_HOME/var/lib/secrets.kdbx` using
 * keepassxc-cli. Stores the master password at `$APPBAY_HOME/etc/kdbx-password`.
 * No-op if the database already exists.
 */
export async function initKdbx(
  appbayHome: string,
  password?: string,
): Promise<KdbxInitResult> {
  const dbPath = resolveKdbxPath(appbayHome);
  const passwordFilePath = join(appbayHome, "etc", "kdbx-password");

  if (existsSync(dbPath)) {
    return { dbPath, passwordPath: passwordFilePath, generated: false };
  }

  await requireKeePassCli();

  // Resolve password: explicit > env var > auto-generate
  let finalPassword = password ?? process.env.APPBAY_KEEPASS_PASSWORD ?? process.env.APPBAY_VAULT_PASSWORD;
  let generated = false;

  if (!finalPassword) {
    finalPassword = randomBytes(24).toString("base64url");
    generated = true;
  }

  // Store password file (chmod 600)
  mkdirSync(join(appbayHome, "etc"), { recursive: true });
  writeFileSync(passwordFilePath, finalPassword, { mode: 0o600 });
  try {
    chmodSync(passwordFilePath, 0o600);
  } catch {
    // chmod may fail on some filesystems
  }

  // Ensure parent directory exists
  const dbDir = dirname(dbPath);
  mkdirSync(dbDir, { recursive: true });

  // Create the .kdbx database.
  //
  // ⚠️ The password is sent TWICE. `db-create --set-password` prompts "Enter password to
  // encrypt database" and then "Repeat password", so a single line leaves the second read
  // at EOF and the tool exits with "Passwords do not match. Failed to set database
  // password." The `echo '<pw>' |` this replaces sent one line, which is why initKdbx
  // could not create a database at all on keepassxc-cli 2.6.6 — measured, not inferred.
  try {
    await runKeepassxc(
      ["db-create", "--set-password", dbPath],
      stdinLines(finalPassword, finalPassword),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create KeePass database at ${dbPath}: ${msg}`);
  }

  return { dbPath, passwordPath: passwordFilePath, generated };
}

/**
 * Store a secret in the KeePass database.
 *
 * Key format: "KEY" → group=default, "APP/KEY" → group=APP.
 * Creates the entry if it doesn't exist, updates it if it does.
 */
export async function setKdbxSecret(
  appbayHome: string,
  keyArg: string,
  value: string,
): Promise<VaultSetResult> {
  const dbPath = resolveKdbxPath(appbayHome);

  if (!existsSync(dbPath)) {
    throw new Error("KeePass database not initialized. Run 'appbay secrets init-kdbx' first.");
  }

  await requireKeePassCli();

  const password = resolveKdbxPassword(appbayHome);
  const parts = keyArg.split("/");
  const key = parts[parts.length - 1];
  const scope = parts.length > 1 ? parts.slice(0, -1).join("/") : "default";
  const entryPath = `${scope}/${key}`;

  // Try to show the entry first to see if it exists
  let entryExists = false;
  try {
    await runKeePassCli(["show", "--quiet", dbPath, entryPath], password);
    entryExists = true;
  } catch {
    // Entry doesn't exist
  }

  if (entryExists) {
    // Update the existing entry's password.
    //
    // 🚨 `--password-prompt`, not `--password <value>`, for two independent reasons.
    //
    // Disclosure: `--password` takes the SECRET ITSELF as an argument, so dropping the
    // shell would not have fixed it — the value would simply move from /bin/sh's argv into
    // keepassxc-cli's own. Same /proc/<pid>/cmdline, same auditd record, same local
    // readers. The exposure is the argv, not the shell.
    //
    // And it never worked: `keepassxc-cli edit` has no `--password` option. Against 2.6.6
    // the old command died with "Unknown option 'password'." before touching the database,
    // so updating an existing secret has been failing for as long as this code has run.
    // `--password-prompt` reads from stdin, as the `add` branch below already did.
    await runKeePassCli(["edit", "--password-prompt", dbPath, entryPath], password, value);
  } else {
    // Ensure the group exists
    try {
      await runKeePassCli(["mkdir", dbPath, scope], password);
    } catch {
      // Group may already exist — that's fine
    }

    // Create new entry with the secret as its password.
    // keepassxc-cli add --password-prompt reads: line 1 = db password, line 2 = entry password
    try {
      await runKeePassCli(["add", "--password-prompt", dbPath, entryPath], password, value);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to add KeePass entry "${entryPath}": ${msg}`);
    }
  }

  return {
    key,
    scope,
    uri: `keepass://${entryPath}`,
  };
}

/**
 * Retrieve a secret from the KeePass database. Returns null if not found.
 *
 * Key format: "KEY" → group=default, "APP/KEY" → group=APP.
 */
export async function getKdbxSecret(
  appbayHome: string,
  keyArg: string,
): Promise<string | null> {
  const dbPath = resolveKdbxPath(appbayHome);

  if (!existsSync(dbPath)) {
    throw new Error("KeePass database not initialized. Run 'appbay secrets init-kdbx' first.");
  }

  await requireKeePassCli();

  const password = resolveKdbxPassword(appbayHome);
  const parts = keyArg.split("/");
  const key = parts[parts.length - 1];
  const scope = parts.length > 1 ? parts.slice(0, -1).join("/") : "default";
  const entryPath = `${scope}/${key}`;

  try {
    const result = await runKeePassCli(
      ["show", "--quiet", "--attributes", "Password", dbPath, entryPath],
      password,
    );
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Delete a secret from the KeePass database. Returns true if it existed.
 *
 * Key format: "KEY" → group=default, "APP/KEY" → group=APP.
 */
export async function deleteKdbxSecret(
  appbayHome: string,
  keyArg: string,
): Promise<{ deleted: boolean; key: string; scope: string }> {
  const dbPath = resolveKdbxPath(appbayHome);

  if (!existsSync(dbPath)) {
    throw new Error("KeePass database not initialized. Run 'appbay secrets init-kdbx' first.");
  }

  await requireKeePassCli();

  const password = resolveKdbxPassword(appbayHome);
  const parts = keyArg.split("/");
  const key = parts[parts.length - 1];
  const scope = parts.length > 1 ? parts.slice(0, -1).join("/") : "default";
  const entryPath = `${scope}/${key}`;

  try {
    await runKeePassCli(["rm", dbPath, entryPath], password);
    return { deleted: true, key, scope };
  } catch {
    return { deleted: false, key, scope };
  }
}

/**
 * List secrets in the KeePass database, optionally filtered by scope (group).
 */
export async function listKdbxSecrets(
  appbayHome: string,
  scope?: string,
): Promise<VaultListResult> {
  const dbPath = resolveKdbxPath(appbayHome);

  if (!existsSync(dbPath)) {
    return { entries: [], total: 0, byScope: {} };
  }

  await requireKeePassCli();

  const password = resolveKdbxPassword(appbayHome);
  const targetPath = scope ?? "/";

  try {
    const result = await runKeePassCli(
      ["ls", "-R", "-f", dbPath, targetPath],
      password,
    );

    if (!result) return { entries: [], total: 0, byScope: {} };

    const entries: VaultEntry[] = [];
    let currentGroup = "";

    for (const line of result.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Lines ending with "/" are group names
      if (trimmed.endsWith("/")) {
        currentGroup = trimmed.replace(/\/$/, "");
        continue;
      }

      // Skip the Recycle Bin
      if (currentGroup === "Recycle Bin" || currentGroup.startsWith("Recycle Bin/")) continue;

      const entryScope = currentGroup || "default";
      entries.push({ key: trimmed, scope: entryScope });
    }

    // Filter by scope if requested
    const filtered = scope ? entries.filter((e) => e.scope === scope) : entries;

    // Group by scope
    const byScope: Record<string, string[]> = {};
    for (const entry of filtered) {
      const list = byScope[entry.scope] ?? [];
      list.push(entry.key);
      byScope[entry.scope] = list;
    }

    return { entries: filtered, total: filtered.length, byScope };
  } catch {
    return { entries: [], total: 0, byScope: {} };
  }
}

// ---------------------------------------------------------------------------
// Secret scanning
// ---------------------------------------------------------------------------

/** Patterns that suggest an env var holds a secret value. */
const SECRET_PATTERNS = [
  /passw/i, /secret/i, /token/i, /key$/i, /api.?key/i,
  /credential/i, /auth/i, /private/i, /cert/i,
];

/** Values that look like placeholders (not real secrets). */
const PLACEHOLDER_PATTERNS = [
  /^changeme$/i, /^placeholder$/i, /^xxx+$/i, /^todo$/i,
  /^replace.?me$/i, /^your.?/i, /^<.*>$/, /^$/,
];

/**
 * Scan an app's compose and .env files for secret-like environment variables.
 *
 * Discovers variables that look like they should be managed by a secret
 * provider, identifies placeholders, and suggests vault URIs.
 */
export function scanAppSecrets(
  app: DiscoveredApp,
  appbayHome: string,
): ScanResult {
  const vars: ScannedVar[] = [];
  const appDir = join(appbayHome, "etc", "apps", app.name);

  // 1. Scan compose environment blocks
  const services = app.composeContent?.services;
  if (services && typeof services === "object") {
    for (const [svcName, svcDef] of Object.entries(services as Record<string, unknown>)) {
      if (!svcDef || typeof svcDef !== "object") continue;
      const env = (svcDef as Record<string, unknown>).environment;
      if (!env) continue;

      if (Array.isArray(env)) {
        for (const entry of env) {
          if (typeof entry !== "string") continue;
          const eqIdx = entry.indexOf("=");
          if (eqIdx < 0) continue;
          const key = entry.substring(0, eqIdx);
          const value = entry.substring(eqIdx + 1);
          vars.push({
            key, value, source: "compose", service: svcName,
            looksSecret: SECRET_PATTERNS.some((p) => p.test(key)),
            isPlaceholder: PLACEHOLDER_PATTERNS.some((p) => p.test(value)),
            hasVaultRef: value.startsWith("vault://") || value.startsWith("keepass://"),
          });
        }
      } else if (typeof env === "object") {
        for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
          const val = String(value ?? "");
          vars.push({
            key, value: val, source: "compose", service: svcName,
            looksSecret: SECRET_PATTERNS.some((p) => p.test(key)),
            isPlaceholder: PLACEHOLDER_PATTERNS.some((p) => p.test(val)),
            hasVaultRef: val.startsWith("vault://") || val.startsWith("keepass://"),
          });
        }
      }
    }
  }

  // 2. Scan .env and .env.template / .env.example files
  for (const envFile of [".env", ".env.template", ".env.example", ".env.sample"]) {
    const envPath = join(appDir, envFile);
    if (!existsSync(envPath)) continue;

    try {
      const content = readFileSync(envPath, "utf-8");
      const source = envFile === ".env" ? "env" as const : "env-template" as const;

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 0) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, "");

        // Skip if already found in compose
        if (vars.some((v) => v.key === key)) continue;

        vars.push({
          key, value, source,
          looksSecret: SECRET_PATTERNS.some((p) => p.test(key)),
          isPlaceholder: PLACEHOLDER_PATTERNS.some((p) => p.test(value)),
          hasVaultRef: value.startsWith("vault://") || value.startsWith("keepass://"),
        });
      }
    } catch {
      // Skip unreadable files
    }
  }

  const secrets = vars.filter((v) => v.looksSecret);
  const unmanaged = secrets.filter((v) => !v.hasVaultRef && (v.isPlaceholder || !v.value));

  return { appName: app.name, vars, secrets, unmanaged };
}
