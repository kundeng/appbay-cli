/**
 * Tests for container runtime resolution.
 *
 * Strategy: resolution reads a real project.yaml from a real temp directory
 * rather than a mocked fs. The whole point of this module is that a file on
 * disk decides which binary gets spawned, so a test that mocks the read tests
 * the mock. Spawning is not exercised here — that needs a container runtime
 * present and belongs in an integration test.
 *
 * ⚠️ Every test clears the cache in beforeEach. The cache is keyed by home path
 * and lives for the process, so without this the second test in a file would
 * read the first one's answer and pass for the wrong reason.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveContainerRuntime,
  containerBin,
  clearContainerRuntimeCache,
  runtimeProfile,
} from "../container-runtime.js";
import { DEFAULT_CONTAINER_RUNTIME } from "../../schemas/instance.js";

let home: string;
const savedEnv = process.env.APPBAY_CONTAINER_RUNTIME;

function writeProjectYaml(contents: string): void {
  writeFileSync(join(home, "project.yaml"), contents, "utf-8");
}

beforeEach(() => {
  home = join(tmpdir(), `appbay-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  clearContainerRuntimeCache();
  delete process.env.APPBAY_CONTAINER_RUNTIME;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  clearContainerRuntimeCache();
  if (savedEnv === undefined) delete process.env.APPBAY_CONTAINER_RUNTIME;
  else process.env.APPBAY_CONTAINER_RUNTIME = savedEnv;
});

describe("resolveContainerRuntime", () => {
  it("defaults to docker when project.yaml is absent", () => {
    expect(resolveContainerRuntime(home)).toBe("docker");
    expect(DEFAULT_CONTAINER_RUNTIME).toBe("docker");
  });

  it("defaults to docker when project.yaml omits the key", () => {
    writeProjectYaml("project: demo\ndomain: local\n");
    expect(resolveContainerRuntime(home)).toBe("docker");
  });

  it("reads podman from project.yaml", () => {
    writeProjectYaml("project: demo\ndomain: local\ncontainer_runtime: podman\n");
    expect(resolveContainerRuntime(home)).toBe("podman");
    expect(containerBin(home)).toBe("podman");
  });

  it("lets APPBAY_CONTAINER_RUNTIME override the file", () => {
    writeProjectYaml("container_runtime: podman\n");
    process.env.APPBAY_CONTAINER_RUNTIME = "docker";
    expect(resolveContainerRuntime(home)).toBe("docker");
  });

  it("ignores an unparseable env override rather than throwing", () => {
    writeProjectYaml("container_runtime: podman\n");
    process.env.APPBAY_CONTAINER_RUNTIME = "containerd";
    expect(resolveContainerRuntime(home)).toBe("podman");
  });

  it("falls back to the default when project.yaml is malformed YAML", () => {
    writeProjectYaml("project: [unclosed\n\tbad: indent\n");
    expect(resolveContainerRuntime(home)).toBe("docker");
  });

  it("falls back to the default when the key holds an unknown runtime", () => {
    // safeParse fails on the whole object, so the value is dropped rather than
    // trusted. A typo must not spawn a binary nobody vetted.
    writeProjectYaml("container_runtime: rkt\n");
    expect(resolveContainerRuntime(home)).toBe("docker");
  });

  it("keeps separate installations separate", () => {
    // The cache is keyed by home. A scalar cache would return the first
    // installation's answer for the second — a bug that only appears on a host
    // running two appbay homes, which is exactly where it is hardest to see.
    const other = join(tmpdir(), `appbay-runtime-other-${Date.now()}`);
    mkdirSync(other, { recursive: true });
    try {
      writeProjectYaml("container_runtime: podman\n");
      writeFileSync(join(other, "project.yaml"), "container_runtime: docker\n", "utf-8");
      expect(resolveContainerRuntime(home)).toBe("podman");
      expect(resolveContainerRuntime(other)).toBe("docker");
      expect(resolveContainerRuntime(home)).toBe("podman");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("re-reads after the cache is cleared for that home", () => {
    writeProjectYaml("container_runtime: docker\n");
    expect(resolveContainerRuntime(home)).toBe("docker");

    writeProjectYaml("container_runtime: podman\n");
    expect(resolveContainerRuntime(home)).toBe("docker"); // still cached

    clearContainerRuntimeCache(home);
    expect(resolveContainerRuntime(home)).toBe("podman");
  });
});

describe("runtimeProfile", () => {
  it("carries the ONE genuinely incompatible format string", () => {
    // Measured against docker 29.4.0 and podman 6.0.2, both services running:
    //   docker info --format {{.ServerVersion}}   -> 29.4.0
    //   podman info --format {{.ServerVersion}}   -> template error, cannot evaluate
    //   podman info --format {{.Version.Version}} -> 6.0.2
    // Every other command appbay issues is identical across the two.
    writeProjectYaml("container_runtime: docker\n");
    expect(runtimeProfile(home).serverVersionFormat).toBe("{{.ServerVersion}}");

    writeProjectYaml("container_runtime: podman\n");
    clearContainerRuntimeCache(home);
    expect(runtimeProfile(home).serverVersionFormat).toBe("{{.Version.Version}}");
  });

  it("names the runtime the operator is actually using", () => {
    // "Docker daemon not responding" while driving podman, with a fix that says
    // `systemctl start docker`, sends someone to repair a thing that is not installed.
    writeProjectYaml("container_runtime: podman\n");
    expect(runtimeProfile(home).displayName).toBe("Podman");
    expect(runtimeProfile(home).startHint).toContain("podman");

    writeProjectYaml("container_runtime: docker\n");
    clearContainerRuntimeCache(home);
    expect(runtimeProfile(home).displayName).toBe("Docker");
    expect(runtimeProfile(home).startHint.toLowerCase()).toContain("docker");
  });

  it("gives every runtime a complete profile", () => {
    // A half-filled profile would surface as `undefined` inside a user-facing hint.
    for (const rt of ["docker", "podman"] as const) {
      writeProjectYaml(`container_runtime: ${rt}\n`);
      clearContainerRuntimeCache(home);
      const p = runtimeProfile(home);
      for (const field of ["displayName", "serverVersionFormat", "installUrl", "startHint"] as const) {
        expect(p[field], `${rt}.${field}`).toBeTruthy();
      }
      expect(p.installUrl).toMatch(/^https:\/\//);
    }
  });

  it("defaults to the docker profile when nothing is configured", () => {
    expect(runtimeProfile(home).displayName).toBe("Docker");
  });
});
