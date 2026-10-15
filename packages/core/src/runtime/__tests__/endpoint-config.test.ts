/**
 * `resolveEndpoint` reads the configured endpoint from etc/system.yaml (S50, 1.2). The
 * environment variables that rank above it are cleared for the test and restored after.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEndpoint, clearContainerRuntimeCache } from "../container-runtime.js";

const VARS = ["APPBAY_RUNTIME_SOCKET", "DOCKER_HOST", "DOCKER_CONTEXT", "APPBAY_CONTAINER_RUNTIME"] as const;
const saved: Record<string, string | undefined> = {};
let home: string;

beforeEach(() => {
  home = join(tmpdir(), `appbay-endpoint-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, "etc"), { recursive: true });
  for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; }
  clearContainerRuntimeCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
  clearContainerRuntimeCache();
});

describe("resolveEndpoint", () => {
  it("uses the endpoint recorded in etc/system.yaml", () => {
    writeFileSync(join(home, "etc", "system.yaml"), "project: demo\nendpoint: ssh://ops@server\n", "utf-8");
    expect(resolveEndpoint(home)).toMatchObject({ kind: "ssh", destination: "ops@server", source: "system.yaml" });
  });

  it("lets DOCKER_HOST override the recorded endpoint for one invocation", () => {
    writeFileSync(join(home, "etc", "system.yaml"), "project: demo\nendpoint: ssh://ops@server\n", "utf-8");
    process.env.DOCKER_HOST = "unix:///tmp/other.sock";
    expect(resolveEndpoint(home)).toEqual({ kind: "unix", path: "/tmp/other.sock", source: "DOCKER_HOST" });
  });

  it("forgets the answer when the cache is cleared, as init does after writing", () => {
    writeFileSync(join(home, "etc", "system.yaml"), "project: demo\nendpoint: ssh://ops@first\n", "utf-8");
    expect(resolveEndpoint(home)).toMatchObject({ destination: "ops@first" });
    writeFileSync(join(home, "etc", "system.yaml"), "project: demo\nendpoint: ssh://ops@second\n", "utf-8");
    clearContainerRuntimeCache(home);
    expect(resolveEndpoint(home)).toMatchObject({ destination: "ops@second" });
  });
});
