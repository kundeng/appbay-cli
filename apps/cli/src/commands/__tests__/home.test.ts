/**
 * Tests for `appbay home` — print, explain, set and clear.
 *
 * These run against a REAL temp filesystem, not fs mocks, because the defect
 * this command answers was a real file (`~/.config/appbay/home`) left pointing
 * at a deleted temp directory. A mocked write proves the call was made; only a
 * real one proves the pointer a later command reads actually changed.
 *
 * HOME is redirected per-test so nothing touches the developer's own
 * `~/.config/appbay/home` — the very leak under test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fixture homes live under the package, NOT under `os.tmpdir()`.
 *
 * One of the warnings under test fires on saved pointers beneath `/tmp`. A
 * fixture home in `/tmp` would make every path look like the defect and the
 * "no warning on a healthy home" case could never pass — a fixture that
 * cannot distinguish healthy from broken tests nothing.
 */
const FIXTURE_ROOT = join(process.cwd(), ".tmp-home-tests");

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_APPBAY_HOME = process.env.APPBAY_HOME;

let fakeHome: string;
let configFile: string;

/**
 * Import the modules fresh after HOME is set.
 *
 * `appbay-home.ts` computes CONFIG_FILE from `homedir()` at module load, so a
 * cached module would keep pointing at the real home and the redirect above
 * would be decorative.
 */
async function loadCommand() {
  vi.resetModules();
  const mod = await import("../home.js");
  return mod.homeCommand;
}

/** Run the command with argv, capturing stdout/stderr and any exit code. */
async function run(...argv: string[]): Promise<{ out: string; err: string; code: number | null }> {
  const command = await loadCommand();
  let out = "";
  let err = "";
  let code: number | null = null;

  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
    out += a.join(" ") + "\n";
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
    err += a.join(" ") + "\n";
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
    code = c ?? 0;
    // Abort the action the way a real exit would, so assertions after the
    // refusal point in the command body do not run.
    throw new Error("__exit__");
  }) as never);

  try {
    await command.parseAsync(["node", "appbay-home", ...argv]);
  } catch (e) {
    if ((e as Error).message !== "__exit__") throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { out, err, code };
}

/** Create a directory that looks like a scaffolded Appbay home. */
function scaffold(path: string): string {
  mkdirSync(join(path, "etc", "apps"), { recursive: true });
  return path;
}

beforeEach(() => {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  fakeHome = mkdtempSync(join(FIXTURE_ROOT, "home-"));
  process.env.HOME = fakeHome;
  delete process.env.APPBAY_HOME;
  configFile = join(fakeHome, ".config", "appbay", "home");
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_APPBAY_HOME !== undefined) process.env.APPBAY_HOME = ORIGINAL_APPBAY_HOME;
  else delete process.env.APPBAY_HOME;
});

// ---------------------------------------------------------------------------
// Bare `appbay home` — the contract scripts depend on
// ---------------------------------------------------------------------------

describe("appbay home", () => {
  it("prints ONLY the path, so $(appbay home) stays usable", async () => {
    const target = scaffold(join(fakeHome, "myappbay"));
    mkdirSync(join(fakeHome, ".config", "appbay"), { recursive: true });
    writeFileSync(configFile, target + "\n");

    const { out } = await run();
    expect(out).toBe(target + "\n");
    // Guard the regression directly: no prose may leak into the captured value.
    expect(out.trim().split("\n")).toHaveLength(1);
  });

  it("falls back to ~/.appbay when nothing is configured", async () => {
    const { out } = await run();
    expect(out.trim()).toBe(join(fakeHome, ".appbay"));
  });
});

// ---------------------------------------------------------------------------
// `--explain`
// ---------------------------------------------------------------------------

describe("appbay home --explain", () => {
  it("names every tier and marks the winner", async () => {
    const target = scaffold(join(fakeHome, "myappbay"));
    mkdirSync(join(fakeHome, ".config", "appbay"), { recursive: true });
    writeFileSync(configFile, target + "\n");

    const { out } = await run("--explain");
    expect(out).toContain("1. env var");
    expect(out).toContain("2. system config");
    expect(out).toContain("3. saved config");
    expect(out).toContain("4. built-in default");
    expect(out).toContain(`Resolved: ${target}`);
    // The winning line, and only it, carries the arrow.
    const arrowed = out.split("\n").filter((l) => l.startsWith("  →"));
    expect(arrowed).toHaveLength(1);
    expect(arrowed[0]).toContain(target);
  });

  it("shows the env var outranking a saved pointer", async () => {
    mkdirSync(join(fakeHome, ".config", "appbay"), { recursive: true });
    writeFileSync(configFile, "/saved/path\n");
    process.env.APPBAY_HOME = "/env/path";

    const { out } = await run("--explain");
    expect(out).toContain("Resolved: /env/path");
    // The shadowed tier is still REPORTED — that is the diagnostic value.
    expect(out).toContain("/saved/path");
  });

  it("warns when the resolved path is gone — the leak's signature", async () => {
    const dead = join(fakeHome, "deleted-scratch");
    mkdirSync(join(fakeHome, ".config", "appbay"), { recursive: true });
    writeFileSync(configFile, dead + "\n");

    const { out } = await run("--explain");
    expect(out).toContain("does not exist");
    expect(out).toContain("appbay home set");
  });

  it("warns when a saved pointer is under a temp directory", async () => {
    mkdirSync(join(fakeHome, ".config", "appbay"), { recursive: true });
    const tmpTarget = scaffold(mkdtempSync(join(tmpdir(), "appbay-scratch-")));
    writeFileSync(configFile, tmpTarget + "\n");
    try {
      const { out } = await run("--explain");
      expect(out).toContain("will not survive a reboot");
    } finally {
      rmSync(tmpTarget, { recursive: true, force: true });
    }
  });

  it("does NOT warn about a healthy scaffolded home — the check can pass", async () => {
    const target = scaffold(join(fakeHome, "myappbay"));
    mkdirSync(join(fakeHome, ".config", "appbay"), { recursive: true });
    writeFileSync(configFile, target + "\n");

    const { out } = await run("--explain");
    expect(out).not.toContain("⚠️");
  });
});

// ---------------------------------------------------------------------------
// `home set`
// ---------------------------------------------------------------------------

describe("appbay home set", () => {
  it("writes the pointer that later commands read", async () => {
    const target = scaffold(join(fakeHome, "myappbay"));
    const { out, code } = await run("set", target);
    expect(code).toBeNull();
    expect(readFileSync(configFile, "utf-8").trim()).toBe(target);
    expect(out).toContain(`Resolved home is now ${target}`);
  });

  it("stores an absolute path when given a relative one", async () => {
    const target = scaffold(join(fakeHome, "myappbay"));
    const cwd = process.cwd();
    process.chdir(fakeHome);
    try {
      await run("set", "myappbay");
    } finally {
      process.chdir(cwd);
    }
    // On macOS /tmp is a symlink, so compare the resolved suffix, not the literal.
    expect(readFileSync(configFile, "utf-8").trim()).toContain("myappbay");
    expect(readFileSync(configFile, "utf-8").trim().startsWith("/")).toBe(true);
    expect(target).toBeTruthy();
  });

  it("REFUSES a path that does not exist", async () => {
    const { err, code } = await run("set", join(fakeHome, "nope"));
    expect(code).toBe(1);
    expect(err).toContain("does not exist");
    expect(existsSync(configFile)).toBe(false);
  });

  it("accepts a missing path under --force, and says so", async () => {
    const target = join(fakeHome, "nope");
    const { out, code } = await run("set", target, "--force");
    expect(code).toBeNull();
    expect(out).toContain("does not exist yet");
    expect(readFileSync(configFile, "utf-8").trim()).toBe(target);
  });

  it("warns when the target exists but was never initialised", async () => {
    const target = join(fakeHome, "bare");
    mkdirSync(target);
    const { out } = await run("set", target);
    expect(out).toContain("does not look initialised");
    expect(readFileSync(configFile, "utf-8").trim()).toBe(target);
  });

  it("REFUSES while $APPBAY_HOME shadows the saved tier", async () => {
    process.env.APPBAY_HOME = "/env/wins";
    const target = scaffold(join(fakeHome, "myappbay"));

    const { err, code } = await run("set", target);
    expect(code).toBe(1);
    expect(err).toContain("higher-precedence tier");
    expect(err).toContain("/env/wins");
    // Nothing was written — a refusal that still writes is not a refusal.
    expect(existsSync(configFile)).toBe(false);
  });

  it("writes under --force while shadowed, and admits it is still shadowed", async () => {
    process.env.APPBAY_HOME = "/env/wins";
    const target = scaffold(join(fakeHome, "myappbay"));

    const { out, code } = await run("set", target, "--force");
    expect(code).toBeNull();
    expect(readFileSync(configFile, "utf-8").trim()).toBe(target);
    expect(out).toContain("still shadowed");
    expect(out).toContain("/env/wins");
    // It must NOT claim the resolved home changed, because it did not.
    expect(out).not.toContain(`Resolved home is now ${target}`);
  });
});

// ---------------------------------------------------------------------------
// `home clear`
// ---------------------------------------------------------------------------

describe("appbay home clear", () => {
  it("removes the pointer and reports the tier now in force", async () => {
    const target = scaffold(join(fakeHome, "myappbay"));
    mkdirSync(join(fakeHome, ".config", "appbay"), { recursive: true });
    writeFileSync(configFile, target + "\n");

    const { out } = await run("clear");
    expect(existsSync(configFile)).toBe(false);
    expect(out).toContain("Removed");
    expect(out).toContain(`Resolved home is now ${join(fakeHome, ".appbay")}`);
  });

  it("says nothing was cleared rather than claiming a change", async () => {
    const { out } = await run("clear");
    expect(out).toContain("Nothing to clear");
  });
});
