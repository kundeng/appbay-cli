import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SecretStore } from "../store.js";
import { EnvSecretProvider } from "../providers/env.js";
import { FileSecretProvider } from "../providers/file.js";
import { SopsSecretProvider } from "../providers/sops.js";
import { VaultSecretProvider } from "../providers/vault.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory for test secret files. */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "appbay-secrets-"));
}

/** Build a fully-wired SecretStore with all providers registered. */
function makeStore(): SecretStore {
  const store = new SecretStore();
  store.registerProvider(new EnvSecretProvider());
  store.registerProvider(new FileSecretProvider());
  store.registerProvider(new VaultSecretProvider());
  store.registerProvider(new SopsSecretProvider());
  return store;
}

// ---------------------------------------------------------------------------
// 1. parseUri parses all 4 URI schemes correctly
// ---------------------------------------------------------------------------

describe("SecretStore.parseUri", () => {
  it("parses all 4 URI schemes correctly", () => {
    const store = new SecretStore();

    expect(store.parseUri("vault://project/env/path")).toEqual({
      scheme: "vault",
      path: "project/env/path",
    });

    expect(store.parseUri("file:///run/secrets/db_password")).toEqual({
      scheme: "file",
      path: "/run/secrets/db_password",
    });

    expect(store.parseUri("env://DB_PASSWORD")).toEqual({
      scheme: "env",
      path: "DB_PASSWORD",
    });

    expect(store.parseUri("sops://secrets.yaml#db.password")).toEqual({
      scheme: "sops",
      path: "secrets.yaml#db.password",
    });
  });

  // -------------------------------------------------------------------------
  // 2. parseUri returns null for non-URI strings
  // -------------------------------------------------------------------------

  it("returns null for non-URI strings", () => {
    const store = new SecretStore();

    expect(store.parseUri("plain-string")).toBeNull();
    expect(store.parseUri("just_a_value")).toBeNull();
    expect(store.parseUri("12345")).toBeNull();
    expect(store.parseUri("")).toBeNull();
    // Unsupported scheme
    expect(store.parseUri("https://example.com")).toBeNull();
    expect(store.parseUri("ftp://server/file")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. env:// provider resolves environment variable
// ---------------------------------------------------------------------------

describe("EnvSecretProvider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves an existing environment variable", async () => {
    process.env.TEST_SECRET_VAR = "super-secret-value";
    const provider = new EnvSecretProvider();

    const value = await provider.resolve("env://TEST_SECRET_VAR");
    expect(value).toBe("super-secret-value");
  });

  // -------------------------------------------------------------------------
  // 4. env:// provider reports missing var as error
  // -------------------------------------------------------------------------

  it("reports missing variable via check", async () => {
    delete process.env.NONEXISTENT_VAR;
    const provider = new EnvSecretProvider();

    const result = await provider.check("env://NONEXISTENT_VAR");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("NONEXISTENT_VAR");
    expect(result.error).toContain("not set");
  });

  it("throws on resolve for missing variable", async () => {
    delete process.env.NONEXISTENT_VAR;
    const provider = new EnvSecretProvider();

    await expect(
      provider.resolve("env://NONEXISTENT_VAR"),
    ).rejects.toThrow("not set");
  });
});

// ---------------------------------------------------------------------------
// 5. file:// provider resolves file content
// ---------------------------------------------------------------------------

describe("FileSecretProvider", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves file content with trailing whitespace trimmed", async () => {
    const secretPath = path.join(tmpDir, "db_password");
    await fs.writeFile(secretPath, "my-secret-password\n");

    const provider = new FileSecretProvider();
    const value = await provider.resolve(`file://${secretPath}`);

    expect(value).toBe("my-secret-password");
  });

  // -------------------------------------------------------------------------
  // 6. file:// provider reports missing file as error (autoGenerate: false)
  // -------------------------------------------------------------------------

  it("reports missing file via check when autoGenerate is disabled", async () => {
    const provider = new FileSecretProvider({ autoGenerate: false });
    const missingPath = path.join(tmpDir, "does-not-exist");

    const result = await provider.check(`file://${missingPath}`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found or not readable");
  });

  it("throws on resolve for missing file when autoGenerate is disabled", async () => {
    const provider = new FileSecretProvider({ autoGenerate: false });
    const missingPath = path.join(tmpDir, "does-not-exist");

    await expect(
      provider.resolve(`file://${missingPath}`),
    ).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// FileSecretProvider auto-generate (Feature 1.13)
// ---------------------------------------------------------------------------

describe("FileSecretProvider auto-generate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("check() returns ok: true for a missing file when autoGenerate is enabled", async () => {
    const provider = new FileSecretProvider(); // default: autoGenerate: true
    const missingPath = path.join(tmpDir, "not-yet-created");

    const result = await provider.check(`file://${missingPath}`);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("resolve() creates the secret file when it does not exist", async () => {
    const provider = new FileSecretProvider();
    const secretPath = path.join(tmpDir, "auto-generated-secret");

    const value = await provider.resolve(`file://${secretPath}`);

    // File must now exist on disk
    const stat = await fs.stat(secretPath);
    expect(stat.isFile()).toBe(true);

    // File content must match what was returned
    const content = await fs.readFile(secretPath, "utf-8");
    expect(content).toBe(value);
  });

  it("resolve() returns a 32-character random string", async () => {
    const provider = new FileSecretProvider();
    const secretPath = path.join(tmpDir, "length-check");

    const value = await provider.resolve(`file://${secretPath}`);
    expect(value).toHaveLength(32);
  });

  it("resolve() returns the same value on subsequent calls (persisted)", async () => {
    const provider = new FileSecretProvider();
    const secretPath = path.join(tmpDir, "persist-check");

    const first = await provider.resolve(`file://${secretPath}`);
    const second = await provider.resolve(`file://${secretPath}`);
    expect(first).toBe(second);
  });

  it("resolve() creates parent directories as needed", async () => {
    const provider = new FileSecretProvider();
    const secretPath = path.join(tmpDir, "nested", "deep", "secret");

    await expect(provider.resolve(`file://${secretPath}`)).resolves.toHaveLength(32);

    const stat = await fs.stat(secretPath);
    expect(stat.isFile()).toBe(true);
  });

  it("resolve() writes the secret file with mode 0o600", async () => {
    const provider = new FileSecretProvider();
    const secretPath = path.join(tmpDir, "mode-check");

    await provider.resolve(`file://${secretPath}`);

    const stat = await fs.stat(secretPath);
    // Mask to permission bits only (ignore file type bits)
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// 7. SecretStore routes to correct provider by scheme
// ---------------------------------------------------------------------------

describe("SecretStore routing", () => {
  let tmpDir: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("routes to env provider for env:// URIs", async () => {
    process.env.ROUTED_SECRET = "routed-value";
    const store = makeStore();

    const value = await store.resolve("env://ROUTED_SECRET");
    expect(value).toBe("routed-value");
  });

  it("routes to file provider for file:// URIs", async () => {
    const secretPath = path.join(tmpDir, "api_key");
    await fs.writeFile(secretPath, "file-based-secret");
    const store = makeStore();

    const value = await store.resolve(`file://${secretPath}`);
    expect(value).toBe("file-based-secret");
  });

  // -------------------------------------------------------------------------
  // 8. SecretStore reports unknown scheme as error
  // -------------------------------------------------------------------------

  it("reports unknown scheme as error on resolve", async () => {
    const store = new SecretStore();
    // No providers registered

    await expect(
      store.resolve("env://SOME_VAR"),
    ).rejects.toThrow('No provider registered for scheme "env"');
  });

  it("reports invalid URI on resolve", async () => {
    const store = makeStore();

    await expect(
      store.resolve("not-a-uri"),
    ).rejects.toThrow("Invalid or unsupported secret URI");
  });

  it("reports unknown scheme via check", async () => {
    const store = new SecretStore();
    // No providers registered

    const result = await store.check("env://SOME_VAR");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No provider registered");
  });
});

// ---------------------------------------------------------------------------
// 9. checkAll returns results for all URIs
// ---------------------------------------------------------------------------

describe("SecretStore.checkAll", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns a CheckResult for each URI", async () => {
    process.env.EXISTING_VAR = "exists";
    delete process.env.MISSING_VAR;

    const store = makeStore();
    const results = await store.checkAll([
      "env://EXISTING_VAR",
      "env://MISSING_VAR",
      "not-a-uri",
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toContain("not set");
    expect(results[2].ok).toBe(false);
    expect(results[2].error).toContain("Invalid or unsupported");
  });
});

// ---------------------------------------------------------------------------
// 10. VaultSecretProvider — reports error when vault is not initialized
// ---------------------------------------------------------------------------

describe("VaultSecretProvider (vault not initialized)", () => {
  it("throws an error when vault is not configured", async () => {
    const provider = new VaultSecretProvider();

    // In the test environment, no vault is initialized.
    // The provider should throw a descriptive error.
    await expect(
      provider.resolve("vault://project/prod/DB_PASSWORD"),
    ).rejects.toThrow();
  });

  it("reports ok: false via check when vault is not configured", async () => {
    const provider = new VaultSecretProvider();

    const result = await provider.check("vault://project/prod/DB_PASSWORD");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Bonus: SopsSecretProvider — CLI-based, reports CLI-not-found when absent
// ---------------------------------------------------------------------------

describe("SopsSecretProvider (CLI not installed)", () => {
  it("throws an error when sops binary is absent", async () => {
    const provider = new SopsSecretProvider();

    await expect(
      provider.resolve("sops://secrets.yaml#db.password"),
    ).rejects.toThrow();
  });

  it("reports ok: false via check when CLI is absent", async () => {
    const provider = new SopsSecretProvider();

    const result = await provider.check("sops://secrets.yaml#db.password");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("rejects URI missing '#key' fragment", async () => {
    const provider = new SopsSecretProvider();

    await expect(
      provider.resolve("sops://secrets.yaml"),
    ).rejects.toThrow(/Invalid sops/);
  });
});
