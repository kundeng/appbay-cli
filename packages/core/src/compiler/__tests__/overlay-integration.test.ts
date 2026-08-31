/**
 * Integration tests for the conditional overlay system.
 *
 * Overlays activate when their peer apps are INSTALLED — RFC-001 §5. `when: [ollama]`
 * asserts ollama is part of the declared app set, which is a fact about desired state,
 * knowable at compile time and needing no container runtime.
 *
 * ⚠️ These tests used to seed every app into one directory and then vary a hand-fed
 * `activeApps` set. That could express states the real system cannot reach — "ollama is
 * installed but not active" was a set the caller could pass and the compiler would honour.
 * Installed-ness is now derived from the tree, so each case builds the app directory it is
 * actually describing, and the assertions test what a host would really do.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { compile } from "../compile.js";
import { SYSTEM_APPS } from "../../system-apps.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;
let stateDir: string;

/**
 * Materialise apps into a fresh appsDir and return it.
 *
 * `names` are taken from SYSTEM_APPS when present. ⚠️ `searxng` is NOT a system app, but
 * open-webui's AND overlay names it as a peer — and since installed-ness now comes from the
 * tree, the only way to satisfy that clause is for a directory called `searxng` to exist.
 * A bare compose file is enough: `when:` asks whether the app is declared, not what it is.
 */
async function appsDirWith(label: string, names: string[]): Promise<string> {
  const appsDir = join(testDir, label, "etc/apps");
  await mkdir(appsDir, { recursive: true });
  const fromSystem = new Set(SYSTEM_APPS.map((a) => a.name));

  for (const app of SYSTEM_APPS) {
    if (!names.includes(app.name)) continue;
    const appDir = join(appsDir, app.name);
    for (const [filename, content] of Object.entries(app.files)) {
      const filePath = join(appDir, filename);
      await mkdir(filePath.substring(0, filePath.lastIndexOf("/")), { recursive: true });
      await writeFile(filePath, content);
    }
  }

  for (const name of names.filter((n) => !fromSystem.has(n))) {
    const appDir = join(appsDir, name);
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, "docker-compose.yml"),
      `services:\n  ${name}:\n    image: ${name}:latest\n`,
    );
  }

  return appsDir;
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "appbay-overlay-test-"));
  stateDir = join(testDir, "var/lib/state");
  await mkdir(stateDir, { recursive: true });
});

describe("Overlay integration", () => {
  it("injects OLLAMA_BASE_URL when ollama is installed", async () => {
    const appsDir = await appsDirWith("with-ollama", ["ollama", "open-webui"]);
    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "renders-1"),
      stateDir,
      apps: ["open-webui"],
    });

    const app = result.apps.find((a) => a.appName === "open-webui")!;
    expect(app.rendered).toContain("OLLAMA_BASE_URL");
    expect(app.rendered).toContain("ENABLE_OLLAMA_API=true");
  });

  it("does NOT inject ENABLE_OLLAMA_API when ollama is not installed", async () => {
    // OLLAMA_BASE_URL is always present (base env var with default),
    // but ENABLE_OLLAMA_API=true is only injected by the conditional overlay.
    const appsDir = await appsDirWith("no-peers", ["open-webui"]);
    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "renders-2"),
      stateDir,
      apps: ["open-webui"],
    });

    expect(result.apps).toHaveLength(1);
    expect(result.apps[0]!.rendered).not.toContain("ENABLE_OLLAMA_API");
  });

  it("reports warnings for every overlay whose peers are absent", async () => {
    const appsDir = await appsDirWith("no-peers-warn", ["open-webui"]);
    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "renders-3"),
      stateDir,
      apps: ["open-webui"],
    });

    const overlayWarnings = result.warnings.filter((w) =>
      w.includes("Overlay skipped"),
    );
    expect(overlayWarnings.length).toBe(3);
  });

  it("activates an AND overlay only when ALL peers are installed", async () => {
    // The ollama+searxng overlay needs both.
    const partialDir = await appsDirWith("ollama-only", ["ollama", "open-webui"]);
    const resultPartial = await compile({
      appsDir: partialDir,
      rendersDir: join(testDir, "renders-4a"),
      stateDir,
      apps: ["open-webui"],
    });
    expect(resultPartial.apps[0]!.rendered).not.toContain("ENABLE_RAG_WEB_SEARCH");

    const fullDir = await appsDirWith("both-peers", ["ollama", "searxng", "open-webui"]);
    const resultFull = await compile({
      appsDir: fullDir,
      rendersDir: join(testDir, "renders-4b"),
      stateDir,
      apps: ["open-webui"],
    });
    expect(resultFull.apps[0]!.rendered).toContain("ENABLE_RAG_WEB_SEARCH=true");
    expect(resultFull.apps[0]!.rendered).toContain("SEARXNG_QUERY_URL");
  });

  it("compiles an app without overlays unchanged, whatever else is installed", async () => {
    const appsDir = await appsDirWith("whoami-plus", ["ollama", "whoami"]);
    const result = await compile({
      appsDir,
      rendersDir: join(testDir, "renders-5"),
      stateDir,
      apps: ["whoami"],
    });

    expect(result.apps).toHaveLength(1);
    expect(result.warnings.length).toBe(0);
    expect(result.apps[0]!.rendered).not.toContain("OLLAMA");
  });

  it("targeting one app does not change what it renders — RFC-001 §5.2", async () => {
    // The regression this whole change exists to kill: `appbay up open-webui` and
    // `appbay up` must agree, because installed-ness is a property of the tree and not of
    // the command line. With `activeApps` supplied by the caller, narrowing the targets
    // narrowed the set and silently deactivated overlays.
    const appsDir = await appsDirWith("targeting", ["ollama", "searxng", "open-webui"]);

    const all = await compile({
      appsDir,
      rendersDir: join(testDir, "renders-6a"),
      stateDir,
    });
    const targeted = await compile({
      appsDir,
      rendersDir: join(testDir, "renders-6b"),
      stateDir,
      apps: ["open-webui"],
    });

    expect(targeted.apps).toHaveLength(1);
    expect(targeted.apps[0]!.rendered).toBe(
      all.apps.find((a) => a.appName === "open-webui")!.rendered,
    );
    expect(targeted.apps[0]!.rendered).toContain("ENABLE_RAG_WEB_SEARCH=true");
  });
});
