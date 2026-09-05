/**
 * A shepherd's payload goes on stdin, never on argv. Both wrapper-file modes used to pass
 * the secret bytes (and the seed that decrypts the encrypted bundle) inside `sh -c` on the
 * docker command line, readable by every process on the host for the life of the run
 * (review 2026-09-05, ledger 25).
 */
import { describe, it, expect } from "vitest";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { runShepherd } from "../run-shepherd.js";
import { stdinFiles, STDIN_FILE_WRITER } from "../../secrets/resolve-for-deploy.js";

function capture() {
  const calls: Array<{ argv: string[]; input?: string }> = [];
  const exec = (argv: string[], spawn: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> => {
    calls.push({ argv, input: spawn.input === undefined ? undefined : String(spawn.input) });
    return { status: 0, stdout: "", stderr: "", pid: 1, output: [], signal: null };
  };
  return { calls, exec };
}

describe("runShepherd", () => {
  it("puts the payload on stdin and adds -i; argv carries only the writer script", async () => {
    const { calls, exec } = capture();
    const payload = stdinFiles({ seed: Buffer.from("deadbeef"), "bundle.enc": Buffer.from([1, 2, 3]) });
    await runShepherd({
      target: "appbay.x", image: "busybox:latest", command: ["sh", "-c", STDIN_FILE_WRITER],
      mounts: [{ source: "vol", target: "/out" }], stdin: payload, exec,
    });
    const { argv, input } = calls[0]!;
    expect(argv.slice(0, 3)).toEqual(["run", "--rm", "-i"]);
    expect(argv.join(" ")).not.toContain("deadbeef");
    expect(argv.join(" ")).not.toContain(Buffer.from([1, 2, 3]).toString("base64"));
    expect(input).toBe(payload);
    expect(input).toContain("seed=" + Buffer.from("deadbeef").toString("base64"));
  });

  it("does not add -i or an input when there is no payload", async () => {
    const { calls, exec } = capture();
    await runShepherd({ target: "appbay.x", image: "busybox:latest", command: ["true"], exec });
    expect(calls[0]!.argv.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(calls[0]!.argv).not.toContain("-i");
    expect(calls[0]!.input).toBeUndefined();
  });
});

describe("stdinFiles", () => {
  it("emits one name=base64 line per file", () => {
    expect(stdinFiles({ a: Buffer.from("x"), "b.json": Buffer.from("{}") })).toBe("a=eA==\nb.json=e30=\n");
  });

  it("refuses a name that could leave /out", () => {
    expect(() => stdinFiles({ "../etc/passwd": Buffer.from("x") })).toThrow(/not allowed/);
    expect(() => stdinFiles({ "..": Buffer.from("x") })).toThrow(/not allowed/);
    expect(() => stdinFiles({ "a b": Buffer.from("x") })).toThrow(/not allowed/);
  });
});
