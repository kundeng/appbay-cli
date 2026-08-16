/**
 * Unit tests for the individual secret providers.
 *
 * Each provider is tested in isolation (no SecretStore, no other providers).
 * The SecretStore integration is covered in secret-store.test.ts.
 *
 * Coverage:
 *
 * EnvSecretProvider:
 *   - resolve(): returns value when env var is set
 *   - resolve(): throws when env var is missing
 *   - check(): ok=true when env var is set
 *   - check(): ok=false when env var is missing
 *   - scheme: "env"
 *
 * FileSecretProvider (autoGenerate: true — default):
 *   - resolve(): reads and returns trimmed file content
 *   - resolve(): trailing whitespace / newline is stripped
 *   - resolve(): auto-generates and persists secret for a missing file
 *   - resolve(): throws for a missing file when autoGenerate=false
 *   - resolve(): throws for an unreadable non-ENOENT error path
 *   - check(): ok=true when file exists and is readable
 *   - check(): ok=true for missing file when autoGenerate=true (will be created on deploy)
 *   - check(): ok=false for missing file when autoGenerate=false
 *   - scheme: "file"
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EnvSecretProvider } from "../providers/env.js";
import { FileSecretProvider } from "../providers/file.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory, cleaned up after each test group. */
let tmpDir = "";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "appbay-providers-"));
}

// ---------------------------------------------------------------------------
// EnvSecretProvider
// ---------------------------------------------------------------------------

describe("EnvSecretProvider", () => {
  const provider = new EnvSecretProvider();
  const VAR = "APPBAY_TEST_SECRET_VAR_12345";

  afterEach(() => {
    delete process.env[VAR];
  });

  it('has scheme "env"', () => {
    expect(provider.scheme).toBe("env");
  });

  it("resolve(): returns the env var value when set", async () => {
    process.env[VAR] = "super-secret";
    const result = await provider.resolve(`env://${VAR}`);
    expect(result).toBe("super-secret");
  });

  it("resolve(): throws when the env var is not set", async () => {
    delete process.env[VAR];
    await expect(provider.resolve(`env://${VAR}`)).rejects.toThrow(
      `Environment variable "${VAR}" is not set`,
    );
  });

  it("check(): ok=true when the env var is set", async () => {
    process.env[VAR] = "value";
    const result = await provider.check(`env://${VAR}`);
    expect(result.ok).toBe(true);
    expect(result.uri).toBe(`env://${VAR}`);
  });

  it("check(): ok=false with error message when the env var is missing", async () => {
    delete process.env[VAR];
    const result = await provider.check(`env://${VAR}`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(VAR);
    expect(result.uri).toBe(`env://${VAR}`);
  });

  it("resolve(): handles env vars with special characters in value", async () => {
    const specialValue = "p@$$w0rd!#%^&*()_+-=[]{}|;':\",./<>?";
    process.env[VAR] = specialValue;
    const result = await provider.resolve(`env://${VAR}`);
    expect(result).toBe(specialValue);
  });
});

// ---------------------------------------------------------------------------
// FileSecretProvider — autoGenerate: true (default)
// ---------------------------------------------------------------------------

describe("FileSecretProvider (autoGenerate: true)", () => {
  const provider = new FileSecretProvider(); // default: autoGenerate=true

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('has scheme "file"', () => {
    expect(provider.scheme).toBe("file");
  });

  it("resolve(): reads and returns file content", async () => {
    const filePath = path.join(tmpDir, "db_password");
    await fs.writeFile(filePath, "my-db-secret", "utf-8");

    const result = await provider.resolve(`file://${filePath}`);
    expect(result).toBe("my-db-secret");
  });

  it("resolve(): trims trailing newline from file content", async () => {
    const filePath = path.join(tmpDir, "secret_with_newline");
    await fs.writeFile(filePath, "secret-value\n", "utf-8");

    const result = await provider.resolve(`file://${filePath}`);
    expect(result).toBe("secret-value");
  });

  it("resolve(): trims trailing whitespace and CRLF from file content", async () => {
    const filePath = path.join(tmpDir, "secret_crlf");
    await fs.writeFile(filePath, "secret-value  \r\n", "utf-8");

    const result = await provider.resolve(`file://${filePath}`);
    expect(result).toBe("secret-value");
  });

  it("resolve(): auto-generates and persists a secret for a missing file", async () => {
    const filePath = path.join(tmpDir, "auto_generated_secret");

    // File does not exist yet
    await expect(fs.access(filePath)).rejects.toThrow();

    const generated = await provider.resolve(`file://${filePath}`);

    // Should have returned a non-empty value
    expect(generated).toBeTruthy();
    expect(generated.length).toBeGreaterThanOrEqual(16);

    // File should now exist with that value
    const persisted = await fs.readFile(filePath, "utf-8");
    expect(persisted.trimEnd()).toBe(generated);
  });

  it("resolve(): auto-generated value is deterministic (same file, second read returns same value)", async () => {
    const filePath = path.join(tmpDir, "stable_secret");

    const first = await provider.resolve(`file://${filePath}`);
    const second = await provider.resolve(`file://${filePath}`);

    // Second call reads the persisted file, not a newly generated value
    expect(first).toBe(second);
  });

  it("resolve(): creates parent directories when auto-generating nested paths", async () => {
    const filePath = path.join(tmpDir, "a", "b", "c", "nested_secret");

    const generated = await provider.resolve(`file://${filePath}`);
    expect(generated).toBeTruthy();

    const persisted = await fs.readFile(filePath, "utf-8");
    expect(persisted.trimEnd()).toBe(generated);
  });

  it("check(): ok=true when file exists and is readable", async () => {
    const filePath = path.join(tmpDir, "readable_secret");
    await fs.writeFile(filePath, "value", "utf-8");

    const result = await provider.check(`file://${filePath}`);
    expect(result.ok).toBe(true);
    expect(result.uri).toBe(`file://${filePath}`);
  });

  it("check(): ok=true for a missing file (will be auto-generated on deploy)", async () => {
    const filePath = path.join(tmpDir, "not_yet_created");

    const result = await provider.check(`file://${filePath}`);
    // autoGenerate=true: missing file is NOT an error at check-time
    expect(result.ok).toBe(true);
    // check() should NOT have created the file
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("resolve(): throws with 'Failed to read secret file' for non-ENOENT errors", async () => {
    // Point the URI at a directory — readFile on a directory throws EISDIR
    // (code !== "ENOENT"), so auto-generation must NOT be attempted and the
    // non-ENOENT branch fires: "Failed to read secret file".
    await expect(
      provider.resolve(`file://${tmpDir}`),
    ).rejects.toThrow("Failed to read secret file");
  });
});

// ---------------------------------------------------------------------------
// FileSecretProvider — autoGenerate: false
// ---------------------------------------------------------------------------

describe("FileSecretProvider (autoGenerate: false)", () => {
  const provider = new FileSecretProvider({ autoGenerate: false });

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolve(): returns file content as normal", async () => {
    const filePath = path.join(tmpDir, "existing_secret");
    await fs.writeFile(filePath, "explicit-value", "utf-8");

    const result = await provider.resolve(`file://${filePath}`);
    expect(result).toBe("explicit-value");
  });

  it("resolve(): throws when file is missing (no auto-generation)", async () => {
    const filePath = path.join(tmpDir, "missing_secret");

    await expect(provider.resolve(`file://${filePath}`)).rejects.toThrow(
      `Secret file not found: ${filePath}`,
    );
  });

  it("check(): ok=false when file is missing", async () => {
    const filePath = path.join(tmpDir, "also_missing");

    const result = await provider.check(`file://${filePath}`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
    expect(result.uri).toBe(`file://${filePath}`);
  });

  it("check(): ok=true when file exists", async () => {
    const filePath = path.join(tmpDir, "present_secret");
    await fs.writeFile(filePath, "val", "utf-8");

    const result = await provider.check(`file://${filePath}`);
    expect(result.ok).toBe(true);
  });
});
