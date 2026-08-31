/**
 * Unit tests for the APPBAY_HOME path resolution utilities.
 *
 * Resolution order under test:
 *   1. $APPBAY_HOME env var (highest — overrides everything)
 *   2. System config at /etc/appbay/config (written by appbay init-system)
 *   3. Saved config at ~/.config/appbay/home (written by appbay init)
 *   4. ~/.appbay fallback
 *
 * Tier 2 has its own suite in commands/__tests__/init-system.test.ts; the cases
 * here exercise 1, 3 and 4. The tier numbering in the case names below is the
 * real four-tier order, not the three-tier order this file described until
 * 2026-08-16 — the docblock had gone stale against the code it tests.
 *
 * Tests mock the filesystem reads so no files are actually touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

// Mock the fs module before importing the module under test.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

import * as fs from "node:fs";
import {
  resolveAppbayHome,
  readSavedAppbayHome,
  saveAppbayHome,
  resolveServerCompose,
  resolveAppsDir,
  resolveRendersDir,
  resolveStateDir,
} from "../appbay-home.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGINAL_APPBAY_HOME = process.env.APPBAY_HOME;

beforeEach(() => {
  delete process.env.APPBAY_HOME;
  vi.resetAllMocks();
  // Default: no config file exists.
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

afterEach(() => {
  if (ORIGINAL_APPBAY_HOME !== undefined) {
    process.env.APPBAY_HOME = ORIGINAL_APPBAY_HOME;
  } else {
    delete process.env.APPBAY_HOME;
  }
});

// ---------------------------------------------------------------------------
// readSavedAppbayHome
// ---------------------------------------------------------------------------

describe("readSavedAppbayHome", () => {
  it("returns null when config file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(readSavedAppbayHome()).toBeNull();
  });

  it("returns the trimmed path when config file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("/srv/appbay\n");
    expect(readSavedAppbayHome()).toBe("/srv/appbay");
  });

  it("returns null when config file exists but is empty", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("   \n");
    expect(readSavedAppbayHome()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// saveAppbayHome
// ---------------------------------------------------------------------------

describe("saveAppbayHome", () => {
  it("creates the config directory and writes the path", () => {
    expect(saveAppbayHome("/opt/myappbay")).toBe("saved");
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      join(homedir(), ".config", "appbay"),
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      join(homedir(), ".config", "appbay", "home"),
      "/opt/myappbay\n",
      "utf-8",
    );
  });

  it("🚨 does NOT throw when $HOME is not writable — it reports", () => {
    // Measured on Fedora 43: `appbay init` crashed with a raw bun stack trace
    // (EACCES, mkdir '/home/appbay') for the no-login SERVICE ACCOUNT that
    // `appbay init-system --owner service` creates by default with --no-create-home. The
    // documented next step of the documented bootstrap path was broken for its own default
    // ownership model.
    vi.mocked(fs.mkdirSync).mockImplementation(() => {
      const err = new Error("EACCES: permission denied, mkdir '/home/appbay'");
      throw err;
    });
    expect(() => saveAppbayHome("/var/lib/appbay")).not.toThrow();
    expect(saveAppbayHome("/var/lib/appbay")).toBe("failed");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("🚨 skips the write entirely when the HOST-LEVEL config already records it", () => {
    // Tier 2 outranks tier 3, so a per-operator copy could only ever be shadowed — or, worse,
    // later disagree with the host-level file. Not merely a try/catch: there is nothing here
    // worth attempting.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("home: /var/lib/appbay\n" as never);
    expect(saveAppbayHome("/var/lib/appbay")).toBe("unnecessary");
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("still writes when the host-level config names a DIFFERENT home", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("home: /var/lib/appbay\n" as never);
    expect(saveAppbayHome("/opt/elsewhere")).toBe("saved");
    expect(fs.writeFileSync).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveAppbayHome — 4-tier priority
// ---------------------------------------------------------------------------

describe("resolveAppbayHome", () => {
  it("tier 4 (fallback): returns ~/.appbay when nothing is configured", () => {
    expect(resolveAppbayHome()).toBe(join(homedir(), ".appbay"));
  });

  it("tier 3 (saved config): returns saved path when config file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("/srv/appbay\n");
    expect(resolveAppbayHome()).toBe("/srv/appbay");
  });

  it("tier 1 (env var): $APPBAY_HOME overrides saved config", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("/srv/appbay\n");
    process.env.APPBAY_HOME = "/override/from/env";
    expect(resolveAppbayHome()).toBe("/override/from/env");
  });

  it("tier 1 (env var): $APPBAY_HOME overrides fallback", () => {
    process.env.APPBAY_HOME = "/opt/custom";
    expect(resolveAppbayHome()).toBe("/opt/custom");
  });

  it("returns the exact value of $APPBAY_HOME without modification", () => {
    process.env.APPBAY_HOME = "/opt/custom/appbay-home";
    expect(resolveAppbayHome()).toBe("/opt/custom/appbay-home");
  });
});

// ---------------------------------------------------------------------------
// Derived path resolvers
// ---------------------------------------------------------------------------

describe("resolveServerCompose", () => {
  it("appends docker-compose.server.yml to the default home", () => {
    expect(resolveServerCompose()).toBe(
      join(homedir(), ".appbay", "docker-compose.server.yml"),
    );
  });

  it("appends docker-compose.server.yml to a custom $APPBAY_HOME", () => {
    process.env.APPBAY_HOME = "/srv/appbay";
    expect(resolveServerCompose()).toBe("/srv/appbay/docker-compose.server.yml");
  });
});

describe("resolveAppsDir", () => {
  it("returns $APPBAY_HOME/etc/apps with default home", () => {
    expect(resolveAppsDir()).toBe(join(homedir(), ".appbay", "etc", "apps"));
  });

  it("returns $APPBAY_HOME/etc/apps with custom home", () => {
    process.env.APPBAY_HOME = "/srv/appbay";
    expect(resolveAppsDir()).toBe("/srv/appbay/etc/apps");
  });
});

describe("resolveRendersDir", () => {
  it("returns $APPBAY_HOME/var/lib/renders with default home", () => {
    expect(resolveRendersDir()).toBe(
      join(homedir(), ".appbay", "var", "lib", "renders"),
    );
  });

  it("returns $APPBAY_HOME/var/lib/renders with custom home", () => {
    process.env.APPBAY_HOME = "/srv/appbay";
    expect(resolveRendersDir()).toBe("/srv/appbay/var/lib/renders");
  });
});

describe("resolveStateDir", () => {
  it("returns $APPBAY_HOME/var/lib/state with default home", () => {
    expect(resolveStateDir()).toBe(
      join(homedir(), ".appbay", "var", "lib", "state"),
    );
  });

  it("returns $APPBAY_HOME/var/lib/state with custom home", () => {
    process.env.APPBAY_HOME = "/srv/appbay";
    expect(resolveStateDir()).toBe("/srv/appbay/var/lib/state");
  });
});

// ---------------------------------------------------------------------------
// Cross-function: custom APPBAY_HOME propagates consistently
// ---------------------------------------------------------------------------

describe("Custom $APPBAY_HOME propagates to all resolvers", () => {
  it("all resolvers use the same custom home as their root", () => {
    process.env.APPBAY_HOME = "/custom/root";
    const home = resolveAppbayHome();
    expect(resolveServerCompose()).toContain(home);
    expect(resolveAppsDir()).toContain(home);
    expect(resolveRendersDir()).toContain(home);
    expect(resolveStateDir()).toContain(home);
  });

  it("no two resolvers return the same path", () => {
    process.env.APPBAY_HOME = "/custom/root";
    const paths = [
      resolveServerCompose(),
      resolveAppsDir(),
      resolveRendersDir(),
      resolveStateDir(),
    ];
    expect(new Set(paths).size).toBe(paths.length);
  });
});
