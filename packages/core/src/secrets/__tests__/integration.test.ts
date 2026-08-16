/**
 * Integration tests for the secret resolution system.
 *
 * Tests the full flow: parse URI → route to provider → resolve/check.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SecretStore } from "../store.js";
import { EnvSecretProvider } from "../providers/env.js";
import { FileSecretProvider } from "../providers/file.js";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Secret resolution integration", () => {
  let store: SecretStore;
  let tempDir: string;

  beforeEach(async () => {
    store = new SecretStore();
    store.registerProvider(new EnvSecretProvider());
    store.registerProvider(new FileSecretProvider());
    tempDir = await mkdtemp(join(tmpdir(), "appbay-secret-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves env:// URIs from process.env", async () => {
    process.env.APPBAY_TEST_SECRET = "my-secret-value";
    const value = await store.resolve("env://APPBAY_TEST_SECRET");
    expect(value).toBe("my-secret-value");
    delete process.env.APPBAY_TEST_SECRET;
  });

  it("resolves file:// URIs from disk", async () => {
    const secretFile = join(tempDir, "db_password");
    await writeFile(secretFile, "super-secret-123\n");

    const value = await store.resolve(`file://${secretFile}`);
    expect(value).toBe("super-secret-123");
  });

  it("checkAll reports status for multiple URIs", async () => {
    process.env.APPBAY_EXISTS = "yes";
    const secretFile = join(tempDir, "exists.txt");
    await writeFile(secretFile, "data");

    const results = await store.checkAll([
      "env://APPBAY_EXISTS",
      `file://${secretFile}`,
      "env://APPBAY_DOES_NOT_EXIST",
      `file://${tempDir}/nonexistent.txt`,
      "vault://project/env/key",
    ]);

    expect(results).toHaveLength(5);
    expect(results[0].ok).toBe(true); // env exists
    expect(results[1].ok).toBe(true); // file exists
    expect(results[2].ok).toBe(false); // env missing
    expect(results[3].ok).toBe(true); // file missing but autoGenerate: true — will be created on resolve
    expect(results[4].ok).toBe(false); // vault not configured

    delete process.env.APPBAY_EXISTS;
  });

  it("parseUri handles all supported schemes", () => {
    expect(store.parseUri("env://VAR")).toEqual({ scheme: "env", path: "VAR" });
    expect(store.parseUri("file:///run/secrets/x")).toEqual({ scheme: "file", path: "/run/secrets/x" });
    expect(store.parseUri("vault://proj/env/key")).toEqual({ scheme: "vault", path: "proj/env/key" });
    expect(store.parseUri("sops://file.enc#key")).toEqual({ scheme: "sops", path: "file.enc#key" });
  });

  it("parseUri returns null for non-URI strings", () => {
    expect(store.parseUri("plain-value")).toBeNull();
    expect(store.parseUri("123")).toBeNull();
    expect(store.parseUri("")).toBeNull();
  });

  it("resolve throws for unknown scheme", async () => {
    await expect(store.resolve("unknown://foo")).rejects.toThrow();
  });

  it("file provider trims trailing whitespace and newlines", async () => {
    const f = join(tempDir, "with-newline");
    await writeFile(f, "secret-value\n\n");
    const value = await store.resolve(`file://${f}`);
    expect(value).toBe("secret-value");
  });
});
