/**
 * Integration tests for the conditional overlay system.
 *
 * Tests that overlays activate correctly when peer apps are present
 * in the activeApps set, and inject the right environment variables.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { compile } from "../compile.js";
import { SYSTEM_APPS } from "../../system-apps.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;
let appsDir: string;
let rendersDir: string;
let stateDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "appbay-overlay-test-"));
  appsDir = join(testDir, "etc/apps");
  rendersDir = join(testDir, "var/lib/renders");
  stateDir = join(testDir, "var/lib/state");

  await mkdir(appsDir, { recursive: true });
  await mkdir(rendersDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  // Seed the test apps from embedded system apps
  for (const app of SYSTEM_APPS) {
    if (["ollama", "open-webui", "whoami"].includes(app.name)) {
      const appDir = join(appsDir, app.name);
      for (const [filename, content] of Object.entries(app.files)) {
        const filePath = join(appDir, filename);
        const dir = filePath.substring(0, filePath.lastIndexOf("/"));
        await mkdir(dir, { recursive: true });
        await writeFile(filePath, content);
      }
    }
  }
});

describe("Overlay integration", () => {
  it("injects OLLAMA_BASE_URL when ollama is active", async () => {
    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "renders-1"),
      stateDir,
      apps: ["open-webui"],
      activeApps: new Set(["ollama"]),
    });

    expect(result.apps).toHaveLength(1);
    const app = result.apps[0];
    expect(app.rendered).toContain("OLLAMA_BASE_URL");
    expect(app.rendered).toContain("ENABLE_OLLAMA_API=true");
  });

  it("does NOT inject ENABLE_OLLAMA_API when ollama is inactive", async () => {
    // OLLAMA_BASE_URL is always present (base env var with default),
    // but ENABLE_OLLAMA_API=true is only injected by the conditional overlay.
    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "renders-2"),
      stateDir,
      apps: ["open-webui"],
      activeApps: new Set([]),
    });

    expect(result.apps).toHaveLength(1);
    const app = result.apps[0];
    expect(app.rendered).not.toContain("ENABLE_OLLAMA_API");
  });

  it("reports warnings for inactive overlays", async () => {
    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "renders-3"),
      stateDir,
      apps: ["open-webui"],
      activeApps: new Set([]),
    });

    // All 3 overlays should be skipped (no peer apps active)
    const overlayWarnings = result.warnings.filter((w) =>
      w.includes("Overlay skipped"),
    );
    expect(overlayWarnings.length).toBe(3);
  });

  it("activates AND overlay only when ALL peers are active", async () => {
    // ollama+searxng overlay needs BOTH active
    const resultPartial = await compile({
      appsDir,
      rendersDir: join(testDir, "renders-4a"),
      stateDir,
      apps: ["open-webui"],
      activeApps: new Set(["ollama"]), // only ollama, not searxng
    });

    expect(resultPartial.apps[0].rendered).not.toContain("ENABLE_RAG_WEB_SEARCH");

    // Now with both active
    const resultFull = await compile({
      appsDir,
      rendersDir: join(testDir, "renders-4b"),
      stateDir,
      apps: ["open-webui"],
      activeApps: new Set(["ollama", "searxng"]),
    });

    expect(resultFull.apps[0].rendered).toContain("ENABLE_RAG_WEB_SEARCH=true");
    expect(resultFull.apps[0].rendered).toContain("SEARXNG_QUERY_URL");
  });

  it("compiles app without overlays unchanged", async () => {
    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "renders-5"),
      stateDir,
      apps: ["whoami"],
      activeApps: new Set(["ollama"]),
    });

    expect(result.apps).toHaveLength(1);
    expect(result.warnings.length).toBe(0);
    // whoami has no overlays, shouldn't be affected by active apps
    expect(result.apps[0].rendered).not.toContain("OLLAMA");
  });
});
