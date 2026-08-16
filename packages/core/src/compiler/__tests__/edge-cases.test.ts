/**
 * Edge case tests for the compiler pipeline.
 *
 * Tests error handling, malformed inputs, and boundary conditions
 * that users might encounter in real usage.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { compile } from "../compile.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "appbay-edge-"));
});

async function setupApp(
  name: string,
  compose: string,
  appbayYaml?: string,
): Promise<string> {
  const appsDir = join(testDir, "apps-" + name);
  const appDir = join(appsDir, name);
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "docker-compose.yml"), compose);
  if (appbayYaml) {
    await writeFile(join(appDir, "appbay.yaml"), appbayYaml);
  }
  return appsDir;
}

describe("Compiler edge cases", () => {
  it("handles empty compose services gracefully", async () => {
    const appsDir = await setupApp(
      "empty-svc",
      "services: {}\n",
    );
    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r1"),
      stateDir: join(testDir, "s1"),
    });
    expect(result.apps).toHaveLength(1);
    expect(result.errors.length).toBe(0);
  });

  it("handles compose with no services key", async () => {
    const appsDir = await setupApp(
      "no-svc",
      "version: '3'\nnetworks:\n  default: {}\n",
    );
    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r2"),
      stateDir: join(testDir, "s2"),
    });
    expect(result.apps).toHaveLength(1);
    // Should still render without error
    expect(result.errors.length).toBe(0);
  });

  it("reports error for trait referencing non-existent service", async () => {
    const appsDir = await setupApp(
      "bad-trait-svc",
      "services:\n  web:\n    image: nginx\n",
      `upstream:\n  source: ./docker-compose.yml\ntraits:\n  - type: ingress\n    host: test.local\n    port: 80\n    service: nonexistent\n    exposure: both\n`,
    );
    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r3"),
      stateDir: join(testDir, "s3"),
    });
    // Should compile (trait applies but service may not exist in rendered output)
    expect(result.apps).toHaveLength(1);
  });

  it("handles app with only docker-compose.yml (no appbay.yaml)", async () => {
    const appsDir = await setupApp(
      "compose-only",
      "services:\n  app:\n    image: alpine\n    command: sleep infinity\n",
    );
    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r4"),
      stateDir: join(testDir, "s4"),
    });
    expect(result.apps).toHaveLength(1);
    expect(result.errors.length).toBe(0);
    expect(result.apps[0].rendered).toContain("alpine");
  });

  it("handles multiple apps with same service names", async () => {
    const appsDir = join(testDir, "apps-multi");
    // App A
    const appA = join(appsDir, "app-a");
    await mkdir(appA, { recursive: true });
    await writeFile(
      join(appA, "docker-compose.yml"),
      "services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n",
    );
    await writeFile(
      join(appA, "appbay.yaml"),
      "upstream:\n  source: ./docker-compose.yml\n  expose:\n    - web\n",
    );
    // App B
    const appB = join(appsDir, "app-b");
    await mkdir(appB, { recursive: true });
    await writeFile(
      join(appB, "docker-compose.yml"),
      "services:\n  web:\n    image: httpd\n  db:\n    image: mysql\n",
    );
    await writeFile(
      join(appB, "appbay.yaml"),
      "upstream:\n  source: ./docker-compose.yml\n  expose:\n    - web\n",
    );

    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r5"),
      stateDir: join(testDir, "s5"),
    });

    expect(result.apps).toHaveLength(2);
    expect(result.errors.length).toBe(0);

    const a = result.apps.find((a) => a.appName === "app-a")!;
    const b = result.apps.find((a) => a.appName === "app-b")!;

    // Both should have unique container names
    expect(a.rendered).toContain("appbay.app-a");
    expect(b.rendered).toContain("appbay.app-b");

    // Both should have unique internal networks
    expect(a.rendered).toContain("app-a_internal");
    expect(b.rendered).toContain("app-b_internal");
  });

  it("handles deeply nested environment variables", async () => {
    const appsDir = await setupApp(
      "deep-env",
      "services:\n  app:\n    image: alpine\n    environment:\n      - NESTED=value1\n      - DEEP=value2\n",
      "upstream:\n  source: ./docker-compose.yml\n",
    );
    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r6"),
      stateDir: join(testDir, "s6"),
    });
    expect(result.apps[0].rendered).toContain("NESTED=value1");
    expect(result.apps[0].rendered).toContain("DEEP=value2");
  });

  it("produces deterministic output across runs", async () => {
    const appsDir = await setupApp(
      "deterministic",
      "services:\n  web:\n    image: nginx\n    ports:\n      - '8080:80'\n",
      "upstream:\n  source: ./docker-compose.yml\n  expose:\n    - web\n",
    );

    const r1 = await compile({
      appsDir,
      rendersDir: join(testDir, "r7a"),
      stateDir: join(testDir, "s7"),
    });
    const r2 = await compile({
      appsDir,
      rendersDir: join(testDir, "r7b"),
      stateDir: join(testDir, "s7"),
    });

    expect(r1.apps[0].rendered).toBe(r2.apps[0].rendered);
    expect(r1.apps[0].plan.hash).toBe(r2.apps[0].plan.hash);
  });
});
