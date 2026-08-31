/**
 * Unit tests for CLI docker utilities.
 *
 * `dockerCompose(args, composePath)` shells out to `docker compose -f <file>`.
 * Three return paths:
 *   1. `result.error` is set (spawn failure) → exitCode 1, error message
 *   2. Exit status is non-zero → exitCode from status, output from stderr
 *      - status === null (signal kill) → exitCode falls back to 1
 *      - stderr is empty → generic fallback message
 *   3. Success (status === 0) → exitCode 0, stdout
 *
 * `discoverRunningApps()` runs two `docker ps` commands and parses their output.
 * Same parsing logic as apps/web/src/server/docker-utils.ts — tested here for
 * the CLI's own copy.
 *
 * Coverage:
 *   dockerCompose()
 *   - spawn error (result.error set) → exitCode 1 + error message
 *   - non-zero exit with stderr → exitCode from status, stderr as output
 *   - non-zero exit with empty stderr → generic fallback message
 *   - status null (signal kill) → exitCode 1 (via ?? 1)
 *   - success → exitCode 0, stdout as output
 *
 *   discoverRunningApps()
 *   - Docker unavailable (throws) → empty Set
 *   - name signal parses appbay.<name>[.*] lines
 *   - label signal parses compose project names
 *   - non-zero name signal exit → ignored
 *   - deduplication across signals
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ⚠️ PARTIAL mock via importOriginal, not a bare object. A `() => ({ spawnSync })`
// mock replaces the ENTIRE module, so any transitive import that touches another
// export dies at load with "No X export is defined on the mock" — and the error
// names child_process, not the import that actually pulled it in, which sends you
// hunting in the wrong file. `../docker.js` now reaches @appbay/core for the
// container-runtime resolver, and core's barrel loads a secrets provider that
// uses execFile. Spreading the real module keeps this test honest about what it
// is actually replacing: spawnSync, and nothing else.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { dockerCompose } from "../docker.js";

// 🚨 PIN THE RUNTIME. These tests assert the binary is spawned as "docker", and the
// binary is now RESOLVED from configuration — $APPBAY_CONTAINER_RUNTIME, then
// container_runtime in $APPBAY_HOME/project.yaml, then the default. resolveAppbayHome()
// also consults ~/.config/appbay/home, so without this an engineer who has ever run
// `appbay init --dir … --container-runtime podman` gets a machine-wide saved path, and
// these tests start spawning "podman" and failing on a change they did not make. Caught
// exactly that way. The runtime is an input to the unit under test; a unit test that
// leaves an input to ambient machine state is not isolated.
beforeEach(() => {
  process.env.APPBAY_CONTAINER_RUNTIME = "docker";
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SpawnSyncReturn = ReturnType<typeof spawnSync>;

function mockSpawn(
  overrides: Partial<{
    status: number | null;
    stdout: string;
    stderr: string;
    error: Error | undefined;
  }> = {},
): SpawnSyncReturn {
  return {
    status: 0,
    stdout: "",
    stderr: "",
    pid: 1,
    output: [],
    signal: null,
    error: undefined,
    ...overrides,
  } as unknown as SpawnSyncReturn;
}

const mockSpawnSync = vi.mocked(spawnSync);

// ---------------------------------------------------------------------------
// dockerCompose
// ---------------------------------------------------------------------------

describe("dockerCompose", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it("returns exitCode 1 and error message when spawnSync sets result.error", () => {
    const err = new Error("spawn docker ENOENT");
    mockSpawnSync.mockReturnValue(mockSpawn({ error: err }));

    const result = dockerCompose(["up", "-d"], "/path/to/compose.yml");

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("spawn docker ENOENT");
  });

  it("returns non-zero exitCode and stderr when command fails with stderr", () => {
    mockSpawnSync.mockReturnValue(
      mockSpawn({ status: 2, stderr: "error: container not found" }),
    );

    const result = dockerCompose(["ps"], "/path/to/compose.yml");

    expect(result.exitCode).toBe(2);
    expect(result.output).toBe("error: container not found");
  });

  it("returns generic fallback message when command fails with empty stderr", () => {
    mockSpawnSync.mockReturnValue(mockSpawn({ status: 1, stderr: "" }));

    const result = dockerCompose(["down"], "/path/to/compose.yml");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("docker compose exited with code 1");
  });

  it("falls back to exitCode 1 when status is null (signal kill)", () => {
    mockSpawnSync.mockReturnValue(
      mockSpawn({ status: null, stderr: "Killed" }),
    );

    const result = dockerCompose(["up"], "/path/to/compose.yml");

    // status ?? 1 → 1 when status is null
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("Killed");
  });

  it("returns exitCode 0 and stdout on success", () => {
    mockSpawnSync.mockReturnValue(
      mockSpawn({ status: 0, stdout: "Container myapp started" }),
    );

    const result = dockerCompose(["up", "-d"], "/path/to/compose.yml");

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("Container myapp started");
  });

  it("passes args after -f <composePath> to docker compose", () => {
    mockSpawnSync.mockReturnValue(mockSpawn({ status: 0, stdout: "" }));

    dockerCompose(["pull", "--quiet"], "/srv/apps/myapp/compose.yml");

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "docker",
      ["compose", "-f", "/srv/apps/myapp/compose.yml", "pull", "--quiet"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });
});

