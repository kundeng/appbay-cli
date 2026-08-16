/**
 * Unit tests for the system-level config module (`utils/system-config.ts`).
 *
 * This is the handshake between `init-system` (which writes the ownership model
 * + home path) and `init` (which reads it). The file lives at /etc/appbay/config
 * — a system path, not under any user's home — because the decision is a host
 * property. Tests pass a temp path to the read/write functions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
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

describe("system-config round-trip", () => {
  it("returns null when the config file does not exist", () => {
    expect(readSystemConfig(file)).toBeNull();
  });

  it("round-trips a service-mode config", () => {
    writeSystemConfig({ owner: "service", serviceUser: "llmsvc", home: "/var/lib/appbay" }, file);
    expect(readSystemConfig(file)).toEqual({
      owner: "service",
      serviceUser: "llmsvc",
      home: "/var/lib/appbay",
    });
  });

  it("round-trips an operator-mode config (no service_user)", () => {
    writeSystemConfig({ owner: "operator", home: "/home/kundeng/.appbay" }, file);
    expect(readSystemConfig(file)).toEqual({
      owner: "operator",
      home: "/home/kundeng/.appbay",
    });
  });

  it("returns null for an unknown owner value", () => {
    writeFileSync(file, "owner: bogus\nhome: /x\n", "utf-8");
    expect(readSystemConfig(file)).toBeNull();
  });

  it("returns null when home is missing", () => {
    writeFileSync(file, "owner: service\n", "utf-8");
    expect(readSystemConfig(file)).toBeNull();
  });
});

