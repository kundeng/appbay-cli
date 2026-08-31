/**
 * Integration tests for scoped variable resolution through the compile pipeline.
 *
 * Tests that project.yaml and environment.yaml variables resolve correctly
 * in compose environment, overlays, and trait properties.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { compile } from "../compile.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "appbay-scope-int-"));
});

describe("Scope resolution integration", () => {
  it("resolves project-level variables in compose environment", async () => {
    const appsDir = join(testDir, "apps-proj");
    const appDir = join(appsDir, "myapp");
    await mkdir(appDir, { recursive: true });

    await writeFile(
      join(appDir, "docker-compose.yml"),
      `services:
  web:
    image: nginx
    environment:
      - DOMAIN=\${{project.DOMAIN}}
      - TZ=\${{project.TZ}}
`,
    );

    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r-proj"),
      stateDir: join(testDir, "s-proj"),
      projectVars: { DOMAIN: "home.lan", TZ: "America/New_York" },
    });

    expect(result.apps).toHaveLength(1);
    expect(result.apps[0].rendered).toContain("DOMAIN=home.lan");
    expect(result.apps[0].rendered).toContain("TZ=America/New_York");
  });

  it("environment variables override project variables", async () => {
    const appsDir = join(testDir, "apps-env-override");
    const appDir = join(appsDir, "myapp");
    await mkdir(appDir, { recursive: true });

    await writeFile(
      join(appDir, "docker-compose.yml"),
      `services:
  web:
    image: nginx
    environment:
      - DOMAIN=\${{environment.DOMAIN}}
`,
    );

    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r-env"),
      stateDir: join(testDir, "s-env"),
      projectVars: { DOMAIN: "project.lan" },
      environmentVars: { DOMAIN: "prod.example.com" },
    });

    expect(result.apps[0].rendered).toContain("DOMAIN=prod.example.com");
    expect(result.apps[0].rendered).not.toContain("project.lan");
  });

  it("unresolved variables produce errors with suggestions", async () => {
    const appsDir = join(testDir, "apps-unresolved");
    const appDir = join(appsDir, "myapp");
    await mkdir(appDir, { recursive: true });

    await writeFile(
      join(appDir, "docker-compose.yml"),
      `services:
  web:
    image: nginx
    environment:
      - SECRET=\${{project.MISSING_VAR}}
`,
    );

    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r-unresolved"),
      stateDir: join(testDir, "s-unresolved"),
      projectVars: {},
    });

    const scopeErrors = result.errors.filter((e) => e.stage === "resolve-variables");
    expect(scopeErrors.length).toBeGreaterThan(0);
    expect(scopeErrors[0].suggestion).toContain("project.yaml");
  });

  it("rejects unresolved variables in traits before provider rendering", async () => {
    const appsDir = join(testDir, "apps-unresolved-trait");
    const appDir = join(appsDir, "whoami");
    await mkdir(appDir, { recursive: true });

    await writeFile(
      join(appDir, "docker-compose.yml"),
      `services:
  whoami:
    image: traefik/whoami
`,
    );
    await writeFile(
      join(appDir, "appbay.yaml"),
      `namespace: default
traits:
  - type: ingress
    service: whoami
    host: "whoami.\${{project.DOMAIN}}"
    port: 80
`,
    );

    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r-unresolved-trait"),
      stateDir: join(testDir, "s-unresolved-trait"),
      projectVars: {},
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appName: "whoami",
          stage: "resolve-variables",
          message: expect.stringContaining("app trait: ingress"),
          suggestion: expect.stringContaining("project.yaml"),
        }),
      ]),
    );
    expect(result.apps[0]!.auxiliaryFiles).toEqual([]);
    expect(result.apps[0]!.rendered).not.toContain("project.DOMAIN");
  });

  it("regular ${VAR} docker compose variables are NOT resolved", async () => {
    const appsDir = join(testDir, "apps-docker-vars");
    const appDir = join(appsDir, "myapp");
    await mkdir(appDir, { recursive: true });

    await writeFile(
      join(appDir, "docker-compose.yml"),
      `services:
  web:
    image: nginx
    ports:
      - \${HOST_PORT:-8080}:80
    environment:
      - APP_NAME=\${APP_NAME:-myapp}
`,
    );

    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r-docker"),
      stateDir: join(testDir, "s-docker"),
    });

    // Docker ${VAR} syntax should be preserved, not resolved by Appbay
    expect(result.apps[0].rendered).toContain("${HOST_PORT:-8080}");
    expect(result.apps[0].rendered).toContain("${APP_NAME:-myapp}");
    expect(result.errors.length).toBe(0);
  });

  it("mixed Appbay and Docker variables coexist", async () => {
    const appsDir = join(testDir, "apps-mixed");
    const appDir = join(appsDir, "myapp");
    await mkdir(appDir, { recursive: true });

    await writeFile(
      join(appDir, "docker-compose.yml"),
      `services:
  web:
    image: nginx
    environment:
      - DOMAIN=\${{project.DOMAIN}}
      - PORT=\${PORT:-3000}
`,
    );

    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "r-mixed"),
      stateDir: join(testDir, "s-mixed"),
      projectVars: { DOMAIN: "app.local" },
    });

    expect(result.apps[0].rendered).toContain("DOMAIN=app.local");
    expect(result.apps[0].rendered).toContain("PORT=${PORT:-3000}");
  });
});

// ---------------------------------------------------------------------------
// Unresolved-reference guidance — RFC-001 §4.8
// ---------------------------------------------------------------------------

describe("suggestions for an unresolved ${{scope.KEY}}", () => {
  // 🚨 The old text named `--project-vars` / `--env-vars` and `environment.yaml`. None of
  // the three exist — measured: zero commander options match either flag, and nothing reads
  // environment.yaml. These assertions exist so a suggestion cannot drift back into naming
  // something imaginary; each one names only a thing that is real today.

  async function suggestionsFor(compose: string): Promise<Map<string, string>> {
    const home = await mkdtemp(join(tmpdir(), "appbay-suggest-"));
    const appsDir = join(home, "apps");
    await mkdir(join(appsDir, "a"), { recursive: true });
    await writeFile(join(appsDir, "a", "docker-compose.yml"), compose, "utf-8");
    const result = await compile({
      appsDir,
      rendersDir: join(home, "renders"),
      stateDir: join(home, "state"),
    });
    const out = new Map<string, string>();
    for (const err of result.errors.filter((e) => e.stage === "resolve-variables")) {
      out.set(err.message, err.suggestion ?? "");
    }
    return out;
  }

  it("never names a flag or file that does not exist", async () => {
    const all = [
      ...(await suggestionsFor(
        "services:\n  web:\n    image: nginx\n    environment:\n" +
          "      - A=${{project.NOPE}}\n      - B=${{environment.X}}\n      - C=${{bogus.Y}}\n",
      )).values(),
    ].join("\n");

    expect(all).not.toContain("--project-vars");
    expect(all).not.toContain("--env-vars");
    expect(all).not.toContain("environment.yaml");
  });

  it("tells the truth per scope", async () => {
    const s = await suggestionsFor(
      "services:\n  web:\n    image: nginx\n    environment:\n" +
        "      - A=${{project.NOPE}}\n      - B=${{environment.X}}\n      - C=${{bogus.Y}}\n",
    );
    const find = (needle: string) =>
      [...s.entries()].find(([msg]) => msg.includes(needle))?.[1] ?? "";

    // project: one key resolves, and it says which and from where.
    expect(find('scope "project"')).toContain("${{project.DOMAIN}}");
    expect(find('scope "project"')).toContain("$APPBAY_HOME/project.yaml");

    // environment: the store is not populated, so say that rather than name a file to edit.
    expect(find('scope "environment"')).toContain("nothing populates it");

    // an unknown scope is a typo — list the valid ones.
    expect(find('Unknown scope "bogus"')).toContain("project, environment, service");
  });
});
