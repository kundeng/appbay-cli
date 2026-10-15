/**
 * Every spawn of the container binary reaches the resolved endpoint (S50 1.2, #16).
 *
 * A stand-in `docker` on PATH prints the DOCKER_HOST and DOCKER_CONTEXT it was started
 * with, and answers `context inspect` the way Docker 29 does, so the test runs the real
 * spawn helpers and the real context reader without a daemon.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { containerExec, containerSpawnSync, containerSpawn, clearContainerRuntimeCache, childEnv } from "../container-runtime.js";

const VARS = ["APPBAY_RUNTIME_SOCKET", "DOCKER_HOST", "DOCKER_CONTEXT", "APPBAY_CONTAINER_RUNTIME", "PATH"] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;
let home: string;

const FAKE_DOCKER = `#!/bin/sh
if [ "$1" = "context" ] && [ "$2" = "inspect" ]; then
  case "$3" in
    lab) echo '{"Endpoints":{"docker":{"Host":"ssh://ops@server","SkipTLSVerify":false}},"TLSMaterial":{}}' ;;
    *) echo "context not found" >&2; exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = "context" ] && [ "$2" = "show" ]; then echo default; exit 0; fi
echo "host=\${DOCKER_HOST:-unset} context=\${DOCKER_CONTEXT:-unset}"
`;

beforeEach(() => {
  dir = join(tmpdir(), `appbay-childenv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  home = join(dir, "home");
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "bin", "docker"), FAKE_DOCKER, "utf-8");
  chmodSync(join(dir, "bin", "docker"), 0o755);
  for (const v of VARS) saved[v] = process.env[v];
  for (const v of VARS) if (v !== "PATH") delete process.env[v];
  process.env.PATH = `${join(dir, "bin")}:/usr/bin:/bin`;
  clearContainerRuntimeCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
  clearContainerRuntimeCache();
});

describe("container-binary children follow the resolved endpoint", () => {
  it("containerExec under DOCKER_CONTEXT gets the context's host as DOCKER_HOST and no DOCKER_CONTEXT", () => {
    process.env.DOCKER_CONTEXT = "lab";
    expect(containerExec(["ps"], { appbayHome: home }).output.trim()).toBe("host=ssh://ops@server context=unset");
  });

  it("containerSpawnSync carries the same environment, keeping the caller's other variables", () => {
    process.env.DOCKER_CONTEXT = "lab";
    const r = containerSpawnSync(["ps"], { encoding: "utf-8", env: { ...process.env, EXTRA: "1" } }, home);
    expect(r.stdout.trim()).toBe("host=ssh://ops@server context=unset");
  });

  it("containerSpawn carries it too", async () => {
    process.env.DOCKER_CONTEXT = "lab";
    const child = containerSpawn(["ps"], { appbayHome: home, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const stdout = child.stdout;
    if (!stdout) throw new Error("no stdout pipe");
    stdout.on("data", (c: Buffer) => { out += c.toString(); });
    await once(stdout, "end");
    expect(out.trim()).toBe("host=ssh://ops@server context=unset");
  });

  it("an endpoint recorded in etc/system.yaml reaches the child with nothing exported", () => {
    mkdirSync(join(home, "etc"), { recursive: true });
    writeFileSync(join(home, "etc", "system.yaml"), "project: demo\nendpoint: ssh://deploy@box\n", "utf-8");
    expect(containerExec(["ps"], { appbayHome: home }).output.trim()).toBe("host=ssh://deploy@box context=unset");
  });

  it("an unsupported endpoint leaves the child's environment as it was", () => {
    process.env.DOCKER_CONTEXT = "missing";
    expect(childEnv(home).DOCKER_CONTEXT).toBe("missing");
    expect(childEnv(home).DOCKER_HOST).toBeUndefined();
  });
});
