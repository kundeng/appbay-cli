/**
 * `.env.local` must be created 0600 when it holds a secret — RFC-001 §3.6.
 *
 * ⭐ WHY THIS IS TESTED AT THE PRIMITIVE AND NOT THROUGH `catalogInstall`. The defect is not in
 * the install logic, it is in the ORDER of two filesystem calls: `writeFile` then `chmod`
 * leaves the file at whatever the umask allows for the window between them, and any local
 * process that opens it in that window keeps its descriptor across the later chmod. Driving a
 * whole catalog install to observe a race would test everything except the thing that matters
 * and would not observe the window anyway.
 *
 * So this pins the property the fix relies on: `writeFile`'s `mode` is applied AT CREATION, and
 * without it a permissive umask wins.
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let savedUmask: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "appbay-env-local-mode-"));
  // The worst case an operator can actually be in: a umask that masks nothing.
  savedUmask = process.umask(0o000);
});

afterEach(async () => {
  process.umask(savedUmask);
  await rm(dir, { recursive: true, force: true });
});

async function modeOf(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8);
}

describe("creating a file that will hold a plaintext secret", () => {
  it("🚨 is world-readable without an explicit mode — this is the window", () => {
    // Not a hypothetical: with umask 000 the file lands at 666, and `.env.local` is where a
    // secret goes when the vault was unavailable at install time.
    return writeFile(join(dir, "unsafe"), "SECRET=x\n").then(async () => {
      expect(await modeOf(join(dir, "unsafe"))).toBe("666");
    });
  });

  it("is 0600 when the mode is passed at creation", async () => {
    await writeFile(join(dir, "safe"), "SECRET=x\n", { mode: 0o600 });
    expect(await modeOf(join(dir, "safe"))).toBe("600");
  });

  it("⚠️ mode does NOT apply to an existing file — which is why the chmod stays", async () => {
    // `writeFile`'s mode is honoured only on creation. An install that rewrites an existing
    // `.env.local` would keep the old permissions, so the explicit chmod is a correction
    // rather than redundant belt-and-braces.
    const path = join(dir, "existing");
    await writeFile(path, "first\n");
    expect(await modeOf(path)).toBe("666");
    await writeFile(path, "SECRET=x\n", { mode: 0o600 });
    expect(await modeOf(path), "an existing file keeps its mode").toBe("666");
  });
});
