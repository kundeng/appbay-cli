/**
 * Magic variable generators and persistent value store.
 *
 * Magic variables use the syntax `${type}` or `${type:arg}` in appbay.yaml.
 * Values are generated once and persisted to `generated-values.yaml` so that
 * re-renders are deterministic (same key always returns the same value).
 *
 * Generator types:
 *   - `${password:N}` -- random alphanumeric+special chars of length N
 *   - `${uuid}`       -- crypto.randomUUID()
 *   - `${base64:N}`   -- N random bytes encoded as base64
 *   - `${hash}`       -- deterministic SHA-256 of key tuple (no persistence)
 *   - `${timestamp}`  -- ISO 8601 current time (no persistence, always fresh)
 *
 * See design.md "Scoped variables + magic vars" for details.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { stringify, parse } from "yaml";
import {
  GeneratedValuesFileSchema,
  type GeneratedValueKey,
  type GeneratedValuesFile,
  type GeneratedValue,
} from "../schemas/state.js";

// ---------------------------------------------------------------------------
// Generator functions
// ---------------------------------------------------------------------------

/** Characters used for password generation (alphanumeric + common special chars). */
const PASSWORD_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+";

/**
 * Generate a random password of the specified length using cryptographically
 * secure random bytes. Includes alphanumeric and special characters.
 */
export function generatePassword(length: number): string {
  const bytes = crypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += PASSWORD_CHARS[bytes[i]! % PASSWORD_CHARS.length];
  }
  return result;
}

/** Generate a random UUID v4 using Node.js crypto. */
export function generateUuid(): string {
  return crypto.randomUUID();
}

/**
 * Generate random bytes and encode as base64.
 * @param bytes - Number of random bytes to generate.
 */
export function generateBase64(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64");
}

/**
 * Generate a deterministic SHA-256 hash from the key tuple components.
 * Always produces the same output for the same inputs -- no persistence needed.
 */
export function generateHash(
  namespace: string,
  service: string,
  key: string,
): string {
  const input = [namespace, service, key].join(":");
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** Return the current time as an ISO 8601 string. */
export function generateTimestamp(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Magic variable parser
// ---------------------------------------------------------------------------

/** Result of parsing a magic variable reference. */
export interface ParsedMagicVar {
  type: string;
  arg?: number;
}

/** Known magic variable type names. */
const MAGIC_VAR_TYPES = new Set([
  "password",
  "uuid",
  "base64",
  "hash",
  "timestamp",
]);

/**
 * Parse a magic variable reference string.
 *
 * @param ref - The full reference string including `${}` wrapper, e.g. `${password:16}`.
 * @returns Parsed type and optional numeric argument, or `null` if the ref is
 *          not a recognised magic variable (it may be a Docker Compose variable).
 */
export function parseMagicVar(ref: string): ParsedMagicVar | null {
  // Match ${type} or ${type:number}
  const match = ref.match(/^\$\{(\w+)(?::(\d+))?\}$/);
  if (!match) return null;

  const type = match[1]!;
  if (!MAGIC_VAR_TYPES.has(type)) return null;

  const result: ParsedMagicVar = { type };
  if (match[2] !== undefined) {
    result.arg = parseInt(match[2], 10);
  }
  return result;
}

// ---------------------------------------------------------------------------
// GeneratedValueStore
// ---------------------------------------------------------------------------

/**
 * Build a lookup key string from a GeneratedValueKey for the in-memory map.
 * Uses a delimiter that is unlikely to appear in normal values.
 */
function keyString(k: GeneratedValueKey): string {
  return `${k.namespace}\0${k.service}\0${k.varName}`;
}

/**
 * Persistent store for generated magic variable values.
 *
 * Values are keyed by `(project, environment, service, varName)` and persisted
 * to a YAML file at `$APPBAY_HOME/var/lib/state/generated-values.yaml`.
 *
 * The store keeps an in-memory cache and flushes to disk on demand via `flush()`.
 */
export class GeneratedValueStore {
  /** Path to the generated-values.yaml file. */
  private readonly filePath: string;

  /** In-memory cache of generated values indexed by composite key. */
  private values = new Map<string, GeneratedValue>();

  /** Whether the store has been loaded from disk. */
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Load existing values from the YAML file on disk.
   * Safe to call multiple times -- subsequent calls re-read from disk.
   */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const data = parse(content) as unknown;
      const parsed = GeneratedValuesFileSchema.parse(data);

      this.values.clear();
      for (const entry of parsed.values) {
        this.values.set(keyString(entry.key), entry);
      }
    } catch (err: unknown) {
      // If the file doesn't exist, start with an empty store.
      if (isNodeError(err) && err.code === "ENOENT") {
        this.values.clear();
      } else {
        throw err;
      }
    }
    this.loaded = true;
  }

  /**
   * Get an existing generated value, or `null` if not found.
   * Loads from disk on first access if not already loaded.
   */
  async get(key: GeneratedValueKey): Promise<string | null> {
    if (!this.loaded) await this.load();
    const entry = this.values.get(keyString(key));
    return entry?.value ?? null;
  }

  /**
   * Get an existing value or generate and persist a new one.
   *
   * For `hash` and `timestamp` generators, special rules apply:
   *   - `hash` is deterministic and does NOT require persistence.
   *   - `timestamp` is always fresh and is NOT persisted.
   *
   * All other generators produce a value on first call and return the same
   * value on subsequent calls with the same key.
   *
   * @param key       - Composite key identifying this value.
   * @param generator - Generator specification, e.g. "password:16", "uuid".
   * @returns The generated or cached value string.
   */
  async getOrCreate(
    key: GeneratedValueKey,
    generator: string,
  ): Promise<string> {
    if (!this.loaded) await this.load();

    const parsed = parseMagicVar(`\${${generator}}`);
    if (!parsed) {
      throw new Error(`Unknown magic variable generator: ${generator}`);
    }

    // Timestamp is always fresh -- never persisted.
    if (parsed.type === "timestamp") {
      return generateTimestamp();
    }

    // Hash is deterministic -- no persistence needed.
    if (parsed.type === "hash") {
      return generateHash(key.namespace, key.service, key.varName);
    }

    // Check for existing cached value.
    const existing = this.values.get(keyString(key));
    if (existing) {
      return existing.value;
    }

    // Generate a new value based on the generator type.
    const value = executeGenerator(parsed);

    const entry: GeneratedValue = {
      key,
      value,
      generator,
      createdAt: new Date().toISOString(),
    };

    this.values.set(keyString(key), entry);
    return value;
  }

  /**
   * Write all persisted values to disk as YAML.
   * Creates the parent directory if it does not exist.
   */
  async flush(): Promise<void> {
    const file: GeneratedValuesFile = {
      version: 1,
      values: Array.from(this.values.values()),
    };

    const dir = this.filePath.substring(
      0,
      this.filePath.lastIndexOf("/"),
    );
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, stringify(file), "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Execute a parsed generator and return the generated value string.
 * Handles password, uuid, and base64 generators.
 */
function executeGenerator(parsed: ParsedMagicVar): string {
  switch (parsed.type) {
    case "password":
      return generatePassword(parsed.arg ?? 16);
    case "uuid":
      return generateUuid();
    case "base64":
      return generateBase64(parsed.arg ?? 32);
    default:
      throw new Error(
        `Generator type "${parsed.type}" cannot be executed by the value store`,
      );
  }
}

/** Type guard for Node.js system errors with a `code` property. */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
