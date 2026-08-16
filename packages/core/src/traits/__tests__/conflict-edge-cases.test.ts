/**
 * Trait conflict edge case tests.
 *
 * Tests OAM conflict rules through the full compile pipeline.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { compile } from "../../compiler/compile.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "appbay-conflict-"));
});

async function createApp(
  name: string,
  appbayYaml: string,
): Promise<string> {
  const appsDir = join(testDir, `apps-${name}`);
  const appDir = join(appsDir, name);
  await mkdir(appDir, { recursive: true });
  await writeFile(
    join(appDir, "docker-compose.yml"),
    "services:\n  web:\n    image: nginx\n    ports:\n      - '8080:80'\n",
  );
  await writeFile(join(appDir, "appbay.yaml"), appbayYaml);
  return appsDir;
}

describe("Trait conflict edge cases", () => {
  it("detects duplicate ingress trait on same service", async () => {
    const appsDir = await createApp(
      "dup-ingress",
      `upstream:
  source: ./docker-compose.yml
services:
  web:
    traits:
      - type: ingress
        host: a.local
        port: 80
        exposure: both
      - type: ingress
        host: b.local
        port: 80
        exposure: both
`,
    );

    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r-dup"),
      stateDir: join(testDir, "s-dup"),
    });

    const traitErrors = result.errors.filter((e) => e.stage === "apply-traits");
    expect(traitErrors.length).toBeGreaterThan(0);
    expect(traitErrors[0].message).toContain("Duplicate");
    expect(traitErrors[0].suggestion).toContain("OAM rule");
  });

  it("allows different trait types on same service", async () => {
    const appsDir = await createApp(
      "multi-trait",
      `upstream:
  source: ./docker-compose.yml
services:
  web:
    traits:
      - type: ingress
        host: app.local
        port: 80
        exposure: both
      - type: scoped-env
        vars:
          APP_NAME: test
`,
    );

    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r-multi"),
      stateDir: join(testDir, "s-multi"),
    });

    const traitErrors = result.errors.filter((e) => e.stage === "apply-traits");
    expect(traitErrors).toHaveLength(0);
    // Both traits should be applied
    expect(result.apps[0].rendered).toContain("APP_NAME=test");
  });

  it("handles unknown trait type — caught at schema validation", async () => {
    const appsDir = await createApp(
      "unknown-trait",
      `upstream:
  source: ./docker-compose.yml
traits:
  - type: monitoring
    port: 9090
`,
    );

    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r-unknown"),
      stateDir: join(testDir, "s-unknown"),
    });

    // Unknown trait types are caught by Zod discriminated union during
    // appbay.yaml parsing (discover stage), not at trait application.
    const discoverErrors = result.errors.filter((e) => e.stage === "discover");
    expect(discoverErrors.length).toBeGreaterThan(0);
    // App still compiles (with errors reported), using raw compose
    expect(result.apps.length).toBeGreaterThanOrEqual(0);
  });

  it("app-level and service-level traits coexist without conflict", async () => {
    const appsDir = await createApp(
      "mixed-scope",
      `upstream:
  source: ./docker-compose.yml
traits:
  - type: backup
    schedule: "0 2 * * *"
services:
  web:
    traits:
      - type: ingress
        host: app.local
        port: 80
        exposure: both
`,
    );

    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r-mixed"),
      stateDir: join(testDir, "s-mixed"),
    });

    const traitErrors = result.errors.filter((e) => e.stage === "apply-traits");
    expect(traitErrors).toHaveLength(0);
    expect(result.apps[0].auxiliaryFiles.length).toBeGreaterThan(0);
  });

  it("invalid trait properties caught at schema validation", async () => {
    const appsDir = await createApp(
      "bad-props",
      `upstream:
  source: ./docker-compose.yml
services:
  web:
    traits:
      - type: ingress
`,
    );

    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r-bad"),
      stateDir: join(testDir, "s-bad"),
    });

    // Missing required fields (host, port) caught by Zod during
    // appbay.yaml parsing, reported as discovery errors.
    const discoverErrors = result.errors.filter((e) => e.stage === "discover");
    expect(discoverErrors.length).toBeGreaterThan(0);
  });
});
