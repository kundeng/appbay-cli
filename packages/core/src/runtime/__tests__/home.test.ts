/**
 * The four tiers of APPBAY_HOME, against real files in a temp dir. Five copies of this
 * decision used to exist; the CLI published its answer into the environment so the others
 * would agree. One resolver, tested where it lives.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { explainHome, resolveHome } from "../home.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "appbay-home-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const files = () => ({ hostPointerFile: join(dir, "config"), userPointerFile: join(dir, "home") });

describe("resolveHome", () => {
  it("falls back to ~/.appbay when nothing is configured", () => {
    expect(resolveHome({ env: undefined, ...files() })).toBe(join(homedir(), ".appbay"));
  });

  it("reads the user pointer, trimmed", () => {
    writeFileSync(join(dir, "home"), "/srv/appbay\n");
    expect(resolveHome({ env: undefined, ...files() })).toBe("/srv/appbay");
  });

  it("treats a blank user pointer as absent", () => {
    writeFileSync(join(dir, "home"), "   \n");
    expect(resolveHome({ env: undefined, ...files() })).toBe(join(homedir(), ".appbay"));
  });

  it("prefers the host pointer over the user pointer, and reads only its home key", () => {
    writeFileSync(join(dir, "home"), "/srv/user\n");
    writeFileSync(join(dir, "config"), "owner: root\nhome: /var/lib/appbay\nservice_user: appbay\n");
    expect(resolveHome({ env: undefined, ...files() })).toBe("/var/lib/appbay");
  });

  it("$APPBAY_HOME wins over both files, unmodified", () => {
    writeFileSync(join(dir, "home"), "/srv/user\n");
    writeFileSync(join(dir, "config"), "home: /var/lib/appbay\n");
    expect(resolveHome({ env: "/opt/custom/appbay-home", ...files() })).toBe("/opt/custom/appbay-home");
  });

  it("explains every tier and names the winner", () => {
    writeFileSync(join(dir, "home"), "/srv/user\n");
    const { tiers, winner } = explainHome({ env: undefined, ...files() });
    expect(tiers.map((t) => [t.source, t.value])).toEqual([
      ["env", null], ["system", null], ["saved", "/srv/user"], ["default", join(homedir(), ".appbay")],
    ]);
    expect(winner.source).toBe("saved");
  });
});
