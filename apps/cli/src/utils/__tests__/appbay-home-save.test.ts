/**
 * The pointer writers, against real files. The mocked-fs version of these asserted only that
 * writeFileSync had been called (review 2026-09-05, Seam 5).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync as readReal, rmSync as rmReal, writeFileSync as writeReal, chmodSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAppbayHome } from "../appbay-home.js";

describe("saveAppbayHome", () => {
  // Real files in a temp dir; the mocked-fs version asserted only that writeFileSync was called.
    let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "appbay-save-")); });
  afterEach(() => { rmReal(dir, { recursive: true, force: true }); });

  it("creates the config directory and writes the path", () => {
    const pointer = join(dir, "nested", "home");
    expect(saveAppbayHome("/opt/myappbay", { pointer, hostPointer: join(dir, "absent") })).toBe("saved");
    expect(readReal(pointer, "utf-8")).toBe("/opt/myappbay\n");
  });

  it("reports rather than throws when the directory is not writable", () => {
    const locked = join(dir, "locked"); mkdirSync(locked); chmodSync(locked, 0o500);
    try {
      expect(saveAppbayHome("/opt/x", { pointer: join(locked, "sub", "home"), hostPointer: join(dir, "absent") })).toBe("failed");
    } finally { chmodSync(locked, 0o700); }
  });

  it("skips the write entirely when the host-level config already records it", () => {
    const host = join(dir, "config"); writeReal(host, "home: /var/lib/appbay\n");
    const pointer = join(dir, "home");
    expect(saveAppbayHome("/var/lib/appbay", { pointer, hostPointer: host })).toBe("unnecessary");
    expect(existsSync(pointer)).toBe(false);
  });

  it("still writes when the host-level config names a DIFFERENT home", () => {
    const host = join(dir, "config"); writeReal(host, "home: /var/lib/appbay\n");
    const pointer = join(dir, "home");
    expect(saveAppbayHome("/srv/other", { pointer, hostPointer: host })).toBe("saved");
    expect(readReal(pointer, "utf-8")).toBe("/srv/other\n");
  });
});
