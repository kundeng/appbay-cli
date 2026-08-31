/**
 * The one place that invokes `keepassxc-cli` — RFC-001 §3.1.
 *
 * ⚠️ This module had NO direct tests. `kdbx-crud.test.ts` exercises it, but skips entirely
 * when `keepassxc-cli` is absent — so on any machine without the binary (CI included) the
 * module that exists to keep secrets out of argv had zero coverage. These tests need no
 * binary: they stand up a fake `keepassxc-cli` on PATH and inspect what it received.
 *
 * The property under test is the security one. A secret must reach the child through stdin,
 * and every argument must arrive byte-for-byte without a shell in between — which is exactly
 * what a fake executable can prove and a mock cannot.
 */

import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runKeepassxc, stdinLines } from "../keepassxc-cli.js";

describe("stdinLines", () => {
  // 🚨 The newline contract is load-bearing and I got it wrong once. keepassxc-cli reads a
  // LINE per prompt; a payload with no terminator leaves it blocked until the timeout rather
  // than failing. And `db-create --set-password` prompts twice (enter, then repeat), so a
  // single line produced "Passwords do not match" — the bug that made initKdbx unable to
  // create a database at all.
  it("terminates every value, including the last", () => {
    expect(stdinLines("pw")).toBe("pw\n");
    expect(stdinLines("pw", "secret")).toBe("pw\nsecret\n");
    expect(stdinLines("pw", "pw")).toBe("pw\npw\n");
  });

  it("does not mangle a value containing whitespace or metacharacters", () => {
    const tricky = "has space \t and $(id) `whoami`";
    expect(stdinLines(tricky)).toBe(`${tricky}\n`);
  });

  it("returns an empty payload for no values", () => {
    expect(stdinLines()).toBe("");
  });
});

describe("runKeepassxc", () => {
  let dir: string;
  let originalPath: string | undefined;

  /**
   * A fake `keepassxc-cli` that records its argv, its stdin, AND ITS PARENT'S COMMAND LINE.
   *
   * 🚨 The parent is the part that matters, and my first version of this test missed it.
   * Asserting on the fake's own argv passes whether or not a shell is used, because correct
   * quoting produces an identical argv at the child either way — which is precisely the
   * finding behind §3.1: the escaping was never wrong, the secret was in the SHELL's argv.
   * `/proc/<pid>/cmdline` of the parent is where the difference shows, and it is the exact
   * file a local user would read.
   */
  async function installFake(code = 0): Promise<void> {
    const script = [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > "${join(dir, "argv.txt")}"`,
      `tr '\\0' ' ' < /proc/$PPID/cmdline > "${join(dir, "parent.txt")}" 2>/dev/null || true`,
      `cat > "${join(dir, "stdin.txt")}"`,
      `exit ${code}`,
      "",
    ].join("\n");
    const bin = join(dir, "keepassxc-cli");
    await writeFile(bin, script, "utf-8");
    await chmod(bin, 0o755);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kpxc-fake-"));
    originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("passes arguments verbatim — no shell, so nothing is re-parsed", async () => {
    await installFake();
    // Every one of these is a shell metacharacter. Under `sh -c` they would be expanded,
    // split or swallowed; through execFile they must arrive exactly as written.
    const args = ["show", "--attributes", "$(id)", "a b", "back`tick`", "semi;colon", "*"];
    await runKeepassxc(args, stdinLines("pw"));

    const seen = (await readFile(join(dir, "argv.txt"), "utf-8")).split("\n").slice(0, -1);
    expect(seen).toEqual(args);
  });

  it("delivers the payload on stdin, where it is not world-readable", async () => {
    await installFake();
    await runKeepassxc(["show"], stdinLines("master-pw", "the-secret"));

    expect(await readFile(join(dir, "stdin.txt"), "utf-8")).toBe("master-pw\nthe-secret\n");
  });

  it("keeps the secret out of the child's argv", async () => {
    await installFake();
    await runKeepassxc(["edit", "--password-prompt", "/db.kdbx", "app/KEY"], stdinLines("pw", "s3cret"));

    const argv = await readFile(join(dir, "argv.txt"), "utf-8");
    expect(argv).not.toContain("s3cret");
    expect(argv).not.toContain("pw");
  });

  it("spawns NO SHELL — the secret is absent from the parent's /proc cmdline", async () => {
    // ⚠️ This is the assertion that actually pins §3.1. The child's own argv is clean under
    // either implementation; a composed `sh -c "keepassxc-cli 'show' '--password' 'x'"` puts
    // every argument into the shell's cmdline, world-readable for the life of the call.
    // Linux-only, because /proc is where the exposure lives.
    await installFake();
    await runKeepassxc(["edit", "--password-prompt", "/db.kdbx", "app/KEY"], stdinLines("pw", "s3cret"));

    const parent = await readFile(join(dir, "parent.txt"), "utf-8");
    expect(parent.length).toBeGreaterThan(0); // /proc readable, so the check is meaningful

    // No shell in the chain, and therefore no composed command string.
    expect(parent).not.toMatch(/\bsh\b\s+-c/);
    expect(parent).not.toContain("--password-prompt");
    expect(parent).not.toContain("app/KEY");
  });

  it("rejects on a non-zero exit", async () => {
    await installFake(3);
    await expect(runKeepassxc(["show"], stdinLines("pw"))).rejects.toThrow();
  });

  it("does not reject with EPIPE when the child exits before reading stdin", async () => {
    // A wrong password or a missing database makes keepassxc-cli exit immediately; writing
    // to its closed pipe raises EPIPE, which would otherwise surface as an unhandled error
    // and mask the real exit status.
    const bin = join(dir, "keepassxc-cli");
    await writeFile(bin, "#!/bin/sh\nexit 1\n", "utf-8");
    await chmod(bin, 0o755);

    // Large enough that the write cannot complete before the child is gone.
    const payload = stdinLines("x".repeat(1024 * 512));
    await expect(runKeepassxc(["show"], payload)).rejects.toThrow();
  });

  it("resolves with stdout on success", async () => {
    const bin = join(dir, "keepassxc-cli");
    await writeFile(bin, "#!/bin/sh\ncat > /dev/null\nprintf 'the-value\\n'\n", "utf-8");
    await chmod(bin, 0o755);

    const { stdout } = await runKeepassxc(["show"], stdinLines("pw"));
    expect(stdout.trim()).toBe("the-value");
  });
});
