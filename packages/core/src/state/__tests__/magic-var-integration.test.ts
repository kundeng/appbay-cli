/**
 * Integration tests for magic variable generation and persistence.
 *
 * Tests the GeneratedValueStore — generate once, persist, reuse.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { GeneratedValueStore, parseMagicVar } from "../generated-values.js";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "appbay-magic-int-"));
});

describe("Magic variable persistence", () => {
  it("generates password once and reuses from store", async () => {
    const stateDir = join(testDir, "s1");
    await mkdir(stateDir, { recursive: true });
    const store = new GeneratedValueStore(join(stateDir, "generated-values.yaml"));

    const key = { namespace: "default", service: "db", varName: "DB_PASSWORD" };
    const v1 = await store.getOrCreate(key, "password:16");
    const v2 = await store.getOrCreate(key, "password:16");

    expect(v1).toBe(v2); // Same value on second call
    expect(v1.length).toBe(16);
  });

  it("uuid generated once and persisted", async () => {
    const stateDir = join(testDir, "s2");
    await mkdir(stateDir, { recursive: true });
    const store = new GeneratedValueStore(join(stateDir, "generated-values.yaml"));

    const key = { namespace: "default", service: "app", varName: "APP_ID" };
    const v1 = await store.getOrCreate(key, "uuid");
    const v2 = await store.getOrCreate(key, "uuid");

    expect(v1).toBe(v2);
    expect(v1).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("flush writes state file that survives reload", async () => {
    const stateDir = join(testDir, "s3");
    await mkdir(stateDir, { recursive: true });
    const filePath = join(stateDir, "generated-values.yaml");

    // Generate and flush
    const store1 = new GeneratedValueStore(filePath);
    const key = { namespace: "homelab", service: "web", varName: "SECRET" };
    const original = await store1.getOrCreate(key, "password:20");
    await store1.flush();

    // Load in a new store instance
    const store2 = new GeneratedValueStore(filePath);
    await store2.load();
    const reloaded = await store2.get(key);

    expect(reloaded).toBe(original);
  });

  it("state file contains YAML with generator metadata", async () => {
    const stateDir = join(testDir, "s4");
    await mkdir(stateDir, { recursive: true });
    const filePath = join(stateDir, "generated-values.yaml");

    const store = new GeneratedValueStore(filePath);
    await store.getOrCreate(
      { namespace: "test", service: "api", varName: "TOKEN" },
      "base64:32",
    );
    await store.flush();

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("base64:32");
    expect(content).toContain("TOKEN");
    expect(content).toContain("test");
  });

  it("parseMagicVar parses all supported types", () => {
    expect(parseMagicVar("${password:16}")).toEqual({ type: "password", arg: 16 });
    expect(parseMagicVar("${uuid}")).toEqual({ type: "uuid" });
    expect(parseMagicVar("${hash}")).toEqual({ type: "hash" });
    expect(parseMagicVar("${base64:32}")).toEqual({ type: "base64", arg: 32 });
    expect(parseMagicVar("${timestamp}")).toEqual({ type: "timestamp" });
    expect(parseMagicVar("${HOST_PORT:-8080}")).toBeNull(); // Docker var, not magic
    expect(parseMagicVar("plain-value")).toBeNull();
  });

  it("different keys produce different values", async () => {
    const stateDir = join(testDir, "s5");
    await mkdir(stateDir, { recursive: true });
    const store = new GeneratedValueStore(join(stateDir, "generated-values.yaml"));

    const v1 = await store.getOrCreate(
      { namespace: "a", service: "web", varName: "PW1" },
      "password:16",
    );
    const v2 = await store.getOrCreate(
      { namespace: "a", service: "web", varName: "PW2" },
      "password:16",
    );

    expect(v1).not.toBe(v2); // Different keys → different values
  });
});
