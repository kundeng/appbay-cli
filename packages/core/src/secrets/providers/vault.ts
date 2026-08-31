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
import { resolveMasterPassword } from "../master-password.js";
import { splitScopedKey } from "../scoped-key.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEME = "vault";
const SCRYPT_KEYLEN = 32; // AES-256
const SCRYPT_COST = 16384;
const VAULT_FILENAME = "vault.enc";

/**
 * The v1 salt — a CONSTANT, which is the defect RFC-001 §2.5 exists to fix.
 *
 * 🚨 With a fixed salt the AES key is a pure function of the password, so every appbay vault
 * ever created shares one key space. Two installations with the same password hold files
 * either key opens, and — the part that actually matters — ONE scrypt precomputation for a
 * candidate password attacks every appbay vault in existence rather than one.
 *
 * ⚠️ What a per-vault salt does NOT buy: a stolen file still carries its own salt, so it is
 * still openable with its password. No self-describing format can do otherwise. The gain is
 * that the work must be redone per file.
 *
 * Kept, and never used for writing, because every existing vault on disk is encrypted with it.
 */
const SCRYPT_SALT_V1 = "appbay-vault-v1";

/**
 * v2 header magic.
 *
 * ⚠️ A v1 file has NO header — its first bytes are a random IV — so the two formats are told
 * apart by whether the file starts with this string. A v1 IV whose first 8 bytes spell
 * `APPBAYV2` would be misread, at probability 2^-64; the consequence is a "wrong password"
 * error on a file that is intact, not data loss, and the alternative (no discriminator at all)
 * is not distinguishable either.
 */
const V2_MAGIC = Buffer.from("APPBAYV2", "ascii");
const V2_VERSION = 2;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
/** MAGIC(8) + version(1) + salt(16) + IV(12) + tag(16) */
const V2_HEADER_LENGTH =
  V2_MAGIC.length + 1 + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
/** IV(12) + tag(16) */
const V1_HEADER_LENGTH = IV_LENGTH + TAG_LENGTH;

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

function deriveKey(password: string, salt: Buffer | string): Buffer {
  return scryptSync(password, salt, SCRYPT_KEYLEN, {
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
 * The LAST segment is the key; everything before it is the scope. ⚠️ The depth is UNBOUNDED
 * — the forms below are examples, not a limit. `vault://a/b/c/d/FIELD` resolves `FIELD` under
 * `a/b/c/d`, and nine-segment URIs round-trip through the real Vault.
 *
 * Examples:
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

  let scoped;
  try {
    scoped = splitScopedKey(pathPart);
  } catch {
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

  return { key: scoped.key, scope: scoped.scope, gen };
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

/** What a read recovered: the entries, and the salt the file was encrypted with. */
interface VaultFileContents {
  data: VaultData;
  /** `null` for a v1 file, which has no salt of its own. */
  salt: Buffer | null;
}

function isV2(raw: Buffer): boolean {
  return raw.length >= V2_MAGIC.length && raw.subarray(0, V2_MAGIC.length).equals(V2_MAGIC);
}

/**
 * Read a vault file in EITHER format — RFC-001 §2.5.
 *
 * 🚨 THE V1 PATH IS NOT LEGACY CRUFT TO TIDY AWAY. Every vault written before this change is
 * v1, and dropping the branch does not fail loudly — it fails as "Wrong vault password" on an
 * intact file, which is the worst shape a secrets bug takes: the data is there and nothing can
 * open it. There is no migration command that could help, because by then the operator cannot
 * read the file to migrate it.
 *
 * Reading NEVER rewrites. A v1 file is upgraded on the next WRITE, so a read-only operation on
 * a vault cannot alter the one file whose corruption is unrecoverable.
 */
function readVaultFile(filePath: string, password: string): VaultFileContents {
  if (!existsSync(filePath)) {
    return { data: {}, salt: null };
  }

  const raw = readFileSync(filePath);

  let salt: Buffer | null;
  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;

  if (isV2(raw)) {
    if (raw.length < V2_HEADER_LENGTH) {
      throw new Error("Vault file is corrupted (v2 header is truncated)");
    }
    const version = raw[V2_MAGIC.length];
    if (version !== V2_VERSION) {
      // Forward-compatibility: a NEWER file must not be read with these offsets and reported
      // as a bad password. Say what it is.
      throw new Error(
        `Vault file is format version ${String(version)}; this build understands ${String(V2_VERSION)}. Upgrade appbay.`,
      );
    }
    let at = V2_MAGIC.length + 1;
    salt = raw.subarray(at, (at += SALT_LENGTH));
    iv = raw.subarray(at, (at += IV_LENGTH));
    tag = raw.subarray(at, (at += TAG_LENGTH));
    ciphertext = raw.subarray(at);
  } else {
    // v1: IV(12) + tag(16) + ciphertext, no header, constant salt.
    if (raw.length < V1_HEADER_LENGTH) {
      throw new Error("Vault file is corrupted (too short)");
    }
    salt = null;
    iv = raw.subarray(0, IV_LENGTH);
    tag = raw.subarray(IV_LENGTH, V1_HEADER_LENGTH);
    ciphertext = raw.subarray(V1_HEADER_LENGTH);
  }

  const encKey = deriveKey(password, salt ?? SCRYPT_SALT_V1);

  try {
    const json = decryptData(ciphertext, iv, tag, encKey);
    return { data: JSON.parse(json) as VaultData, salt };
  } catch {
    throw new Error(
      "Wrong vault password. Set the correct APPBAY_VAULT_PASSWORD.",
    );
  }
}

/**
 * Write a vault file. Always v2 — there is no way to ask for v1.
 *
 * A v1 vault therefore upgrades on its first write, with no migration command and nothing for
 * the operator to run. The salt is the one the Vault instance holds, so the key it was
 * constructed with matches what is written here.
 */
function writeVaultFile(
  filePath: string,
  data: VaultData,
  encKey: Buffer,
  salt: Buffer,
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const json = JSON.stringify(data);
  const { ciphertext, iv, tag } = encryptData(json, encKey);

  const buf = Buffer.concat([
    V2_MAGIC,
    Buffer.from([V2_VERSION]),
    salt,
    iv,
    tag,
    ciphertext,
  ]);
  writeFileSync(filePath, buf);
}

// ---------------------------------------------------------------------------
// Vault class (used by both provider and CLI commands)
// ---------------------------------------------------------------------------

export class Vault {
  private filePath: string;
  private encKey: Buffer;
  private salt: Buffer;
  private data: VaultData;

  constructor(filePath: string, password: string) {
    this.filePath = filePath;
    const contents = readVaultFile(filePath, password);
    this.data = contents.data;
    // A v1 file (or no file at all) gets a fresh per-vault salt, and the write path is v2
    // only — so the upgrade happens on the first `set`/`delete` with no migration command.
    // The in-memory entries were already decrypted with the v1 key, so re-deriving here is
    // safe: nothing reads the file again with this key.
    this.salt = contents.salt ?? randomBytes(SALT_LENGTH);
    this.encKey = deriveKey(password, this.salt);
  }

  /** Store a secret. Overwrites if exists. */
  set(key: string, value: string, scope = "default"): void {
    this.data[vaultEntryKey(key, scope)] = value;
    writeVaultFile(this.filePath, this.data, this.encKey, this.salt);
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
    writeVaultFile(this.filePath, this.data, this.encKey, this.salt);
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
 * The master password is resolved by `resolveMasterPassword` (RFC-001 §2.2), which is the
 * single ladder for every store:
 *
 *   1. `APPBAY_MASTER_PASSWORD`
 *   2. `var/lib/secrets/master-password`          <- what `appbay init` writes
 *   3. legacy env: APPBAY_VAULT_PASSWORD, APPBAY_KEEPASS_PASSWORD
 *   4. legacy files: `etc/vault-password`, `etc/kdbx-password`
 *
 * ⚠️ This block used to describe a two-tier ladder ending at `etc/vault-password` "set during
 * appbay init". Init has not written there since §2.2, and tiers 3–4 exist only so an
 * installation predating the consolidation keeps opening.
 */
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
    const password = resolveMasterPassword();
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

      const password = resolveMasterPassword();
      const vault = new Vault(dbPath, password);
      // Vault secrets always resolve due to auto-generation.
      return { uri, ok: true };
    } catch (err) {
      return { uri, ok: false, error: (err as Error).message };
    }
  }
}

export { parseVaultUri };
