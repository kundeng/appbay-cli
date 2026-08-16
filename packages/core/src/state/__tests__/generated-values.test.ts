import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  generatePassword,
  generateUuid,
  generateBase64,
  generateHash,
  generateTimestamp,
  parseMagicVar,
  GeneratedValueStore,
} from "../generated-values.js";
import type { GeneratedValueKey } from "../../schemas/state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory for test state files. */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "appbay-genval-"));
}

/** Build a test key with convenient defaults. */
function makeKey(overrides: Partial<GeneratedValueKey> = {}): GeneratedValueKey {
  return {
    project: "homelab",
    environment: "prod",
    service: "jellyfin",
    varName: "DB_PASSWORD",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. generatePassword produces string of correct length
// ---------------------------------------------------------------------------

describe("Generator functions", () => {
  it("generatePassword produces string of correct length", () => {
    const pw8 = generatePassword(8);
    const pw32 = generatePassword(32);

    expect(pw8).toHaveLength(8);
    expect(pw32).toHaveLength(32);
    // Should contain at least some variety of characters
    expect(typeof pw8).toBe("string");
  });

  // -------------------------------------------------------------------------
  // 2. generateUuid produces valid UUID format
  // -------------------------------------------------------------------------

  it("generateUuid produces valid UUID v4 format", () => {
    const uuid = generateUuid();

    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(uuid).toMatch(uuidRegex);
  });

  // -------------------------------------------------------------------------
  // 3. generateBase64 produces valid base64 of correct byte length
  // -------------------------------------------------------------------------

  it("generateBase64 produces valid base64 of correct byte length", () => {
    const b64_16 = generateBase64(16);
    const b64_32 = generateBase64(32);

    // base64 of N bytes = ceil(N * 4/3) chars with padding
    // 16 bytes -> 24 chars, 32 bytes -> 44 chars
    expect(b64_16).toHaveLength(24);
    expect(b64_32).toHaveLength(44);

    // Should be valid base64
    const base64Regex = /^[A-Za-z0-9+/]+=*$/;
    expect(b64_16).toMatch(base64Regex);
    expect(b64_32).toMatch(base64Regex);

    // Decode back to verify byte count
    const decoded16 = Buffer.from(b64_16, "base64");
    expect(decoded16).toHaveLength(16);
    const decoded32 = Buffer.from(b64_32, "base64");
    expect(decoded32).toHaveLength(32);
  });

  // -------------------------------------------------------------------------
  // 4. generateTimestamp returns a valid ISO 8601 string
  // -------------------------------------------------------------------------

  it("generateTimestamp returns a valid ISO 8601 string", () => {
    const ts = generateTimestamp();
    // Roundtrip through Date — if it's a valid ISO string, parsing and
    // re-serialising must produce the same string.
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it("generateTimestamp returns a string that increments over time", async () => {
    const t1 = generateTimestamp();
    // Yield to the event loop so the wall clock can advance at least 1ms.
    await new Promise((r) => setTimeout(r, 5));
    const t2 = generateTimestamp();
    // Lexicographic order matches chronological order for ISO 8601 strings.
    expect(t2 >= t1).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. generateHash is deterministic
  // -------------------------------------------------------------------------

  it("generateHash is deterministic -- same inputs always produce same output", () => {
    const hash1 = generateHash("homelab", "prod", "jellyfin", "DB_PASSWORD");
    const hash2 = generateHash("homelab", "prod", "jellyfin", "DB_PASSWORD");

    expect(hash1).toBe(hash2);
    // SHA-256 hex is 64 chars
    expect(hash1).toHaveLength(64);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  // -------------------------------------------------------------------------
  // 5. generateHash produces different output for different inputs
  // -------------------------------------------------------------------------

  it("generateHash produces different output for different inputs", () => {
    const hash1 = generateHash("homelab", "prod", "jellyfin", "DB_PASSWORD");
    const hash2 = generateHash("homelab", "dev", "jellyfin", "DB_PASSWORD");
    const hash3 = generateHash("homelab", "prod", "nextcloud", "DB_PASSWORD");

    expect(hash1).not.toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash2).not.toBe(hash3);
  });
});

// ---------------------------------------------------------------------------
// 6. getOrCreate generates on first call, returns same value on second call
// ---------------------------------------------------------------------------

describe("GeneratedValueStore", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    filePath = path.join(tmpDir, "generated-values.yaml");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("getOrCreate generates on first call and returns same value on second", async () => {
    const store = new GeneratedValueStore(filePath);
    const key = makeKey();

    const first = await store.getOrCreate(key, "password:16");
    const second = await store.getOrCreate(key, "password:16");

    expect(first).toHaveLength(16);
    expect(second).toBe(first);
  });

  // -------------------------------------------------------------------------
  // 7. flush writes YAML that can be loaded back (round-trip)
  // -------------------------------------------------------------------------

  it("flush writes YAML that can be loaded back via a new store instance", async () => {
    const store1 = new GeneratedValueStore(filePath);
    const key = makeKey();

    const value = await store1.getOrCreate(key, "password:24");
    await store1.flush();

    // Verify the file exists
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);

    // Load in a fresh store and verify round-trip
    const store2 = new GeneratedValueStore(filePath);
    const loaded = await store2.get(key);

    expect(loaded).toBe(value);
  });

  // -------------------------------------------------------------------------
  // 8. timestamp is NOT persisted (always fresh)
  // -------------------------------------------------------------------------

  it("timestamp is NOT persisted and always returns a fresh value", async () => {
    const store = new GeneratedValueStore(filePath);
    const key = makeKey({ varName: "CREATED_AT" });

    const ts1 = await store.getOrCreate(key, "timestamp");

    // Small delay to ensure different timestamps
    await new Promise((resolve) => setTimeout(resolve, 5));

    const ts2 = await store.getOrCreate(key, "timestamp");

    // Both should be valid ISO 8601 timestamps
    expect(new Date(ts1).toISOString()).toBe(ts1);
    expect(new Date(ts2).toISOString()).toBe(ts2);

    // Should NOT be persisted -- get() should return null
    const persisted = await store.get(key);
    expect(persisted).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Additional: hash is deterministic via getOrCreate and not persisted
  // -------------------------------------------------------------------------

  it("hash is deterministic via getOrCreate and not persisted in the store", async () => {
    const store = new GeneratedValueStore(filePath);
    const key = makeKey({ varName: "HASH_VAL" });

    const h1 = await store.getOrCreate(key, "hash");
    const h2 = await store.getOrCreate(key, "hash");

    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);

    // Hash should not be persisted
    await store.flush();
    const store2 = new GeneratedValueStore(filePath);
    const persisted = await store2.get(key);
    expect(persisted).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Additional: uuid and base64 generators work through getOrCreate
  // -------------------------------------------------------------------------

  it("uuid generator works through getOrCreate and persists", async () => {
    const store = new GeneratedValueStore(filePath);
    const key = makeKey({ varName: "INSTANCE_ID" });

    const val = await store.getOrCreate(key, "uuid");
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(val).toMatch(uuidRegex);

    // Verify persistence
    await store.flush();
    const store2 = new GeneratedValueStore(filePath);
    expect(await store2.get(key)).toBe(val);
  });

  it("getOrCreate throws for an unrecognised generator string", async () => {
    const store = new GeneratedValueStore(filePath);
    const key = makeKey({ varName: "MYSTERY" });

    await expect(store.getOrCreate(key, "foobar")).rejects.toThrow(
      "Unknown magic variable generator: foobar",
    );
  });

  it("load() rethrows non-ENOENT errors (e.g. when filePath points to a directory)", async () => {
    // Pointing readFile at a directory produces EISDIR (code !== "ENOENT"),
    // so load() must rethrow instead of silently initialising an empty store.
    const dirPath = path.join(tmpDir, "dir-not-a-file");
    await fs.mkdir(dirPath);

    const store = new GeneratedValueStore(dirPath);
    await expect(store.load()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9. parseMagicVar parses all 5 types correctly
// ---------------------------------------------------------------------------

describe("parseMagicVar", () => {
  it("parses all 5 magic variable types correctly", () => {
    expect(parseMagicVar("${password:16}")).toEqual({
      type: "password",
      arg: 16,
    });
    expect(parseMagicVar("${uuid}")).toEqual({ type: "uuid" });
    expect(parseMagicVar("${base64:32}")).toEqual({ type: "base64", arg: 32 });
    expect(parseMagicVar("${hash}")).toEqual({ type: "hash" });
    expect(parseMagicVar("${timestamp}")).toEqual({ type: "timestamp" });
  });

  // -------------------------------------------------------------------------
  // 10. parseMagicVar returns null for non-magic refs
  // -------------------------------------------------------------------------

  it("returns null for non-magic variable references", () => {
    // Docker Compose variables
    expect(parseMagicVar("${DB_HOST}")).toBeNull();
    expect(parseMagicVar("${POSTGRES_PASSWORD}")).toBeNull();
    expect(parseMagicVar("${MY_CUSTOM_VAR}")).toBeNull();

    // Invalid format
    expect(parseMagicVar("not-a-var")).toBeNull();
    expect(parseMagicVar("$password:16")).toBeNull();
    expect(parseMagicVar("{password:16}")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // arg-less forms of password and base64
  // -------------------------------------------------------------------------

  it("parses ${password} (no arg) as { type: 'password' } with no arg field", () => {
    const result = parseMagicVar("${password}");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("password");
    expect(result!.arg).toBeUndefined();
  });

  it("parses ${base64} (no arg) as { type: 'base64' } with no arg field", () => {
    const result = parseMagicVar("${base64}");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("base64");
    expect(result!.arg).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Unknown type with numeric arg still returns null
  // -------------------------------------------------------------------------

  it("returns null for unknown type even with a valid :N suffix", () => {
    expect(parseMagicVar("${foobar:16}")).toBeNull();
    expect(parseMagicVar("${secret:32}")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // arg:0 is parsed as numeric 0 (not omitted)
  // -------------------------------------------------------------------------

  it("parses ${password:0} with arg = 0 (degenerate but valid syntax)", () => {
    const result = parseMagicVar("${password:0}");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("password");
    expect(result!.arg).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Non-numeric arg suffix does not match
  // -------------------------------------------------------------------------

  it("returns null when arg suffix is non-numeric (e.g. ${password:abc})", () => {
    // The regex (?::(\d+))? only matches digit-only args.
    // "${password:abc}" does not match the full pattern → null.
    expect(parseMagicVar("${password:abc}")).toBeNull();
  });
});
