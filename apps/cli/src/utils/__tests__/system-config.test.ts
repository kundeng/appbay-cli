/**
 * The system-level config (`utils/system-config.ts`) — where the appbay tree lives on this host.
 *
 * ⭐ THE BACKWARD-COMPATIBILITY CASES ARE THE POINT. RFC-001 S33 narrowed this file to `home:`
 * alone, and every host that ran an older `init-system` still has `owner:` and `service_user:`
 * lines. If those made the file unreadable, the CLI would fall through to a per-operator
 * `~/.config/appbay/home` and silently resolve a different installation — which is the exact
 * failure this tier exists to prevent (probe-86).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSystemConfig, writeSystemConfig } from "../system-config.js";

let file: string;

beforeEach(() => {
  file = join(tmpdir(), `appbay-syscfg-${Date.now()}-${Math.random().toString(36).slice(2)}`, "config");
  mkdirSync(join(file, ".."), { recursive: true });
});

afterEach(() => {
  rmSync(join(file, ".."), { recursive: true, force: true });
});

describe("round-trip", () => {
  it("returns null when the config file does not exist", () => {
    expect(readSystemConfig(file)).toBeNull();
  });

  it("round-trips a home", () => {
    writeSystemConfig({ home: "/var/lib/appbay" }, file);
    expect(readSystemConfig(file)).toEqual({ home: "/var/lib/appbay" });
  });

  it("writes only the home — the ownership model is not duplicated here", () => {
    // Its real record is the file ownership and ACLs on the tree, where it cannot drift.
    writeSystemConfig({ home: "/var/lib/appbay" }, file);
    expect(readFileSync(file, "utf-8")).toBe("home: /var/lib/appbay\n");
  });

  it("returns null when home is missing", () => {
    writeFileSync(file, "some_other_key: value\n", "utf-8");
    expect(readSystemConfig(file)).toBeNull();
  });
});

describe("a file written by an older appbay", () => {
  it("🚨 still resolves, owner and service_user and all", () => {
    // Every host that ran the previous init-system has these lines.
    writeFileSync(file, "owner: service\nservice_user: llmsvc\nhome: /var/lib/appbay\n", "utf-8");
    expect(readSystemConfig(file)).toEqual({ home: "/var/lib/appbay" });
  });

  it("🚨 resolves even when `owner` holds a value nothing recognises", () => {
    // This used to return null — `owner` was VALIDATED on read, so a typo in a field nothing
    // consumed discarded a home that IS consumed, and the CLI fell through to the operator's
    // personal choice. A dead field could move an entire installation.
    writeFileSync(file, "owner: bogus\nhome: /var/lib/appbay\n", "utf-8");
    expect(readSystemConfig(file)).toEqual({ home: "/var/lib/appbay" });
  });

  it("ignores an operator-mode file's missing service_user", () => {
    writeFileSync(file, "owner: operator\nhome: /home/kundeng/.appbay\n", "utf-8");
    expect(readSystemConfig(file)).toEqual({ home: "/home/kundeng/.appbay" });
  });

  it("trims trailing whitespace rather than resolving a path with a space", () => {
    writeFileSync(file, "home: /var/lib/appbay   \n", "utf-8");
    expect(readSystemConfig(file)?.home).toBe("/var/lib/appbay");
  });
});
