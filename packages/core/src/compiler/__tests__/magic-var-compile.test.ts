/**
 * Tests that magic variables resolve through the full compile pipeline.
 * Verifies the Stage 2b2 wiring added in commit 90.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { compile } from "../compile.js";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "appbay-magic-compile-"));
});

describe("Magic variable compile integration", () => {
  it("${password:N} resolves to N-char string in rendered output", async () => {
    const appsDir = join(testDir, "a1");
    const appDir = join(appsDir, "dbapp");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "docker-compose.yml"),
      "services:\n  db:\n    image: postgres\n    environment:\n      - DB_PASS=${password:20}\n");

    const r = await compile({
      appsDir,
      rendersDir: join(testDir, "r1"),
      stateDir: join(testDir, "s1"),
    });

    expect(r.apps).toHaveLength(1);
    const match = r.apps[0].rendered.match(/DB_PASS=(.+)/);
    expect(match).toBeTruthy();
    expect(match![1].trim()).not.toBe("${password:20}");
    expect(match![1].trim().length).toBe(20);
  });

  it("${uuid} resolves to valid UUID format", async () => {
    const appsDir = join(testDir, "a2");
    const appDir = join(appsDir, "uuidapp");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "docker-compose.yml"),
      "services:\n  app:\n    image: alpine\n    environment:\n      - INSTANCE_ID=${uuid}\n");

    const r = await compile({
      appsDir,
      rendersDir: join(testDir, "r2"),
      stateDir: join(testDir, "s2"),
    });

    const match = r.apps[0].rendered.match(/INSTANCE_ID=(.+)/);
    expect(match![1].trim()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("${hash} resolves to deterministic SHA-256", async () => {
    const appsDir = join(testDir, "a3");
    const appDir = join(appsDir, "hashapp");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "docker-compose.yml"),
      "services:\n  web:\n    image: nginx\n    environment:\n      - DEPLOY_HASH=${hash}\n");

    const r1 = await compile({ appsDir, rendersDir: join(testDir, "r3a"), stateDir: join(testDir, "s3a") });
    const r2 = await compile({ appsDir, rendersDir: join(testDir, "r3b"), stateDir: join(testDir, "s3b") });

    const h1 = r1.apps[0].rendered.match(/DEPLOY_HASH=(.+)/)![1].trim();
    const h2 = r2.apps[0].rendered.match(/DEPLOY_HASH=(.+)/)![1].trim();
    expect(h1).toBe(h2); // Deterministic
    expect(h1.length).toBe(64); // SHA-256
  });

  it("persisted values survive across compiles", async () => {
    const appsDir = join(testDir, "a4");
    const appDir = join(appsDir, "persistapp");
    const stateDir = join(testDir, "s4");
    await mkdir(appDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(appDir, "docker-compose.yml"),
      "services:\n  api:\n    image: node\n    environment:\n      - SECRET=${password:16}\n");

    const r1 = await compile({ appsDir, rendersDir: join(testDir, "r4a"), stateDir });
    const r2 = await compile({ appsDir, rendersDir: join(testDir, "r4b"), stateDir });

    const v1 = r1.apps[0].rendered.match(/SECRET=(.+)/)![1].trim();
    const v2 = r2.apps[0].rendered.match(/SECRET=(.+)/)![1].trim();
    expect(v1).toBe(v2); // Same state dir → same value
  });

  it("regular ${VAR} docker syntax is NOT resolved", async () => {
    const appsDir = join(testDir, "a5");
    const appDir = join(appsDir, "dockervar");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "docker-compose.yml"),
      "services:\n  web:\n    image: nginx\n    ports:\n      - ${PORT:-8080}:80\n    environment:\n      - APP=${APP_NAME:-myapp}\n");

    const r = await compile({ appsDir, rendersDir: join(testDir, "r5"), stateDir: join(testDir, "s5") });
    expect(r.apps[0].rendered).toContain("${PORT:-8080}");
    expect(r.apps[0].rendered).toContain("${APP_NAME:-myapp}");
  });

  it("state file written after compile with generated values", async () => {
    const appsDir = join(testDir, "a6");
    const appDir = join(appsDir, "stateapp");
    const stateDir = join(testDir, "s6");
    await mkdir(appDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(appDir, "docker-compose.yml"),
      "services:\n  db:\n    image: postgres\n    environment:\n      - PW=${password:12}\n      - ID=${uuid}\n");

    await compile({ appsDir, rendersDir: join(testDir, "r6"), stateDir });

    const state = await readFile(join(stateDir, "generated-values.yaml"), "utf-8");
    expect(state).toContain("password:12");
    expect(state).toContain("uuid");
    expect(state).toContain("db"); // service name in the key
  });
});
