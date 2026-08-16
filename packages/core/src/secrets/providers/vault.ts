/**
 * Local vault secret provider.
 *
 * Resolves `vault://KEY` URIs from an encrypted JSON file at
 * `$APPBAY_HOME/var/lib/vault.enc`. Zero external dependencies — the vault
 * is managed entirely by the CLI (`appbay secrets set/get/delete`).
 *
 * Storage: AES-256-GCM encrypted JSON file. The encryption key is derived
 * from a master password via scrypt. The vault file contains a single
 * encrypted blob; the decrypted contents are a JSON object mapping
 * `environment/key` to secret values.
 *
 * URI format:
 *   vault://KEY                    — lookup in default environment
 *   vault://ENVIRONMENT/KEY        — lookup in specific environment
 *
 * Environment variables:
 *   APPBAY_HOME            — vault location (default: ~/.appbay)
 *   APPBAY_VAULT_PASSWORD  — master password (avoids interactive prompt)
 *
 * This is the recommended default provider for homelab/single-node
 * deployments. No external server, no API tokens, no containers.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from "node:crypto";
import type { CheckResult, SecretProvider } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEME = "vault";
const SCRYPT_SALT = "appbay-vault-v1";
const SCRYPT_KEYLEN = 32; // AES-256
const SCRYPT_COST = 16384;
const VAULT_FILENAME = "vault.enc";

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

function deriveKey(password: string): Buffer {
  return scryptSync(password, SCRYPT_SALT, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
  }) as Buffer;
}

function encryptData(
  plaintext: string,
  key: Buffer,
): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { ciphertext: encrypted, iv, tag };
}

function decryptData(
  ciphertext: Buffer,
  iv: Buffer,
  tag: Buffer,
  key: Buffer,
): string {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

// ---------------------------------------------------------------------------
// URI parsing
// ---------------------------------------------------------------------------

interface ParsedVaultUri {
  key: string;
  /** Scoping path segments joined with "/". Used as a namespace prefix. */
  scope: string;
  /** Auto-generation hint from ?gen= query parameter. */
  gen: string | null;
}

/**
 * Parse a vault:// URI into key + scope + generation hint.
 *
 * Supported forms:
 *   vault://KEY                          → scope: "default", key: KEY
 *   vault://APP/KEY                      → scope: "APP",     key: KEY
 *   vault://APP/ENV/KEY                  → scope: "APP/ENV", key: KEY
 *   vault://APP/KEY?gen=password:16      → auto-generate if missing
 *   vault://KEY?gen=hex:32               → auto-generate hex
 *
 * Generation hints (after ?gen=):
 *   password:N  — N random alphanumeric chars (default: 32)
 *   hex:N       — N random hex chars
 *   base64:N    — N random bytes, base64 encoded
 *   uuid        — random UUID v4
 */
function parseVaultUri(uri: string): ParsedVaultUri {
  // Split off query string
  const [pathPart, queryPart] = uri.slice("vault://".length).split("?");
  const parts = pathPart.split("/").filter((s) => s.length > 0);

  if (parts.length === 0) {
    throw new Error(
      `Invalid vault:// URI — expected vault://KEY or vault://APP/KEY: ${uri}`,
    );
  }

  // Parse ?gen= query parameter
  let gen: string | null = null;
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    gen = params.get("gen");
  }

  if (parts.length === 1) {
    return { key: parts[0], scope: "default", gen };
  }

  const key = parts[parts.length - 1];
  const scope = parts.slice(0, -1).join("/");
  return { key, scope, gen };
}

// ---------------------------------------------------------------------------
// Auto-generation
// ---------------------------------------------------------------------------

/**
 * Generate a random secret value based on a generation hint.
 *
 * Hints:
 *   "password:N" — N random alphanumeric chars (default N=32)
 *   "hex:N"      — N hex chars
 *   "base64:N"   — N random bytes, base64-url encoded
 *   "uuid"       — random UUID v4
 */
function generateSecret(hint: string): string {
  if (hint === "uuid") {
    return randomUUID();
  }

  const [type, lengthStr] = hint.split(":");
  const length = parseInt(lengthStr ?? "32", 10);

  switch (type) {
    case "password": {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      const bytes = randomBytes(length);
      return Array.from(bytes).map((b) => chars[b % chars.length]).join("");
    }
    case "base64":
      return randomBytes(length).toString("base64url");
    case "hex":
    default:
      return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
  }
}

// ---------------------------------------------------------------------------
// Vault file operations
// ---------------------------------------------------------------------------

/** The in-memory representation of vault contents. */
type VaultData = Record<string, string>; // "scope/key" → value

function vaultEntryKey(key: string, scope: string): string {
  return `${scope}/${key}`;
}

function readVaultFile(filePath: string, encKey: Buffer): VaultData {
  if (!existsSync(filePath)) {
    return {};
  }

  const raw = readFileSync(filePath);
  // File format: 12 bytes IV + 16 bytes auth tag + rest is ciphertext
  if (raw.length < 28) {
    throw new Error("Vault file is corrupted (too short)");
  }

  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);

  try {
    const json = decryptData(ciphertext, iv, tag, encKey);
    return JSON.parse(json) as VaultData;
  } catch {
    throw new Error(
      "Wrong vault password. Set the correct APPBAY_VAULT_PASSWORD.",
    );
  }
}

function writeVaultFile(
  filePath: string,
  data: VaultData,
  encKey: Buffer,
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const json = JSON.stringify(data);
  const { ciphertext, iv, tag } = encryptData(json, encKey);

  // File format: IV (12) + auth tag (16) + ciphertext
  const buf = Buffer.concat([iv, tag, ciphertext]);
  writeFileSync(filePath, buf);
}

// ---------------------------------------------------------------------------
// Vault class (used by both provider and CLI commands)
// ---------------------------------------------------------------------------

export class Vault {
  private filePath: string;
  private encKey: Buffer;
  private data: VaultData;

  constructor(filePath: string, password: string) {
    this.filePath = filePath;
    this.encKey = deriveKey(password);
    this.data = readVaultFile(filePath, this.encKey);
  }

  /** Store a secret. Overwrites if exists. */
  set(key: string, value: string, scope = "default"): void {
    this.data[vaultEntryKey(key, scope)] = value;
    writeVaultFile(this.filePath, this.data, this.encKey);
  }

  /** Retrieve a secret. Returns null if not found. */
  get(key: string, scope = "default"): string | null {
    return this.data[vaultEntryKey(key, scope)] ?? null;
  }

  /** Delete a secret. Returns true if it existed. */
  delete(key: string, scope = "default"): boolean {
    const entryKey = vaultEntryKey(key, scope);
    if (!(entryKey in this.data)) return false;
    delete this.data[entryKey];
    writeVaultFile(this.filePath, this.data, this.encKey);
    return true;
  }

  /** List all secrets in a scope. */
  list(scope = "default"): Array<{ key: string; scope: string }> {
    const prefix = `${scope}/`;
    return Object.keys(this.data)
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ key: k.slice(prefix.length), scope }));
  }

  /** List all secrets across all scopes. */
  listAll(): Array<{ key: string; scope: string }> {
    return Object.keys(this.data).map((k) => {
      // Vault keys are the final URI segment; scopes may contain `/`.
      const slashIdx = k.lastIndexOf("/");
      return {
        scope: k.slice(0, slashIdx),
        key: k.slice(slashIdx + 1),
      };
    });
  }

  /** Check if a secret exists. */
  has(key: string, scope = "default"): boolean {
    return vaultEntryKey(key, scope) in this.data;
  }
}

// ---------------------------------------------------------------------------
// Resolve vault path and password from environment
// ---------------------------------------------------------------------------

function resolveVaultPath(): string {
  const appbayHome =
    process.env.APPBAY_HOME ??
    join(process.env.HOME ?? "/root", ".appbay");
  return join(appbayHome, "var", "lib", VAULT_FILENAME);
}

/**
 * Resolve the vault master password.
 *
 * Priority:
 *   1. APPBAY_VAULT_PASSWORD env var (explicit, overrides everything)
 *   2. $APPBAY_HOME/etc/vault-password file (set during appbay init)
 *   3. Error — user must set one of the above
 */
function resolvePassword(): string {
  // 1. Environment variable (highest priority)
  const envPassword = process.env.APPBAY_VAULT_PASSWORD;
  if (envPassword) return envPassword;

  // 2. Password file (created during appbay init or appbay secrets init)
  const appbayHome =
    process.env.APPBAY_HOME ??
    join(process.env.HOME ?? "/root", ".appbay");
  const passwordFilePath = join(appbayHome, "etc", "vault-password");
  try {
    const filePassword = readFileSync(passwordFilePath, "utf-8").trim();
    if (filePassword) return filePassword;
  } catch {
    // File doesn't exist — fall through
  }

  throw new Error(
    "Vault password required. Set APPBAY_VAULT_PASSWORD or run 'appbay secrets init'.",
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * SecretProvider for `vault://` URIs backed by an encrypted local file.
 *
 * Zero external dependencies. Secrets encrypted with AES-256-GCM, key
 * derived from master password via scrypt.
 */
export class VaultSecretProvider implements SecretProvider {
  readonly scheme = SCHEME;

  async resolve(uri: string): Promise<string> {
    const parsed = parseVaultUri(uri);
    const dbPath = resolveVaultPath();
    const password = resolvePassword();
    const vault = new Vault(dbPath, password);

    const existing = vault.get(parsed.key, parsed.scope);
    if (existing !== null) {
      return existing;
    }

    if (!parsed.gen) {
      throw new Error(
        `Vault secret not found: ${parsed.scope}/${parsed.key}. ` +
          `Set it explicitly or add ?gen=<type> to authorize generation.`,
      );
    }

    // Generation is opt-in in the URI. Externally issued credentials must never be replaced
    // with plausible random values that authenticate to nothing.
    const generated = generateSecret(parsed.gen);
    vault.set(parsed.key, generated, parsed.scope);
    console.error(
      `[vault] Auto-generated secret "${parsed.key}" (scope: ${parsed.scope})`,
    );
    return generated;
  }

  async check(uri: string): Promise<CheckResult> {
    try {
      const parsed = parseVaultUri(uri);
      const dbPath = resolveVaultPath();

      if (!existsSync(dbPath)) {
        return { uri, ok: false, error: "Vault not initialized" };
      }

      const password = resolvePassword();
      const vault = new Vault(dbPath, password);
      // Vault secrets always resolve due to auto-generation.
      return { uri, ok: true };
    } catch (err) {
      return { uri, ok: false, error: (err as Error).message };
    }
  }
}

export { parseVaultUri };
