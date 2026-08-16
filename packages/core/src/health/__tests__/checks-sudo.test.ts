/**
 * Tests for the sudo-detection branch of `checkDockerAccessible`.
 *
 * The function has three outcomes:
 *   1. The current user reaches the daemon without sudo → pass.
 *   2. The daemon is up but only reachable via sudo → fail with a group-
 *      membership fix (NOT "run appbay under sudo").
 *   3. The daemon is genuinely down → fail with the start hint.
 *
 * Outcomes 2 and 3 both start from `containerServerVersion()` returning null,
 * so they are distinguished by whether `sudo -n <bin> info` succeeds. We mock
 * `spawnSync` (which `tryExec` uses) and `containerServerVersion` to drive each
 * branch deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock spawnSync so tryExec returns controlled values. Spread the real module
// so transitive imports (core's secrets provider uses execFile) still load.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

// Mock containerServerVersion so we can force the "daemon did not answer the
// current user" path regardless of the host's real docker state.
//
// ⚠️ MOCK THE MODULE THE CODE ACTUALLY IMPORTS, NOT THE BARREL. This test used to live in
// apps/cli and mock `@appbay/core`; when the checks moved INTO core (issue #71), that mock
// stopped intercepting anything, because core's checks.ts imports
// `../runtime/container-runtime.js` directly and never goes through its own barrel. The
// real function then ran and the failure looked like a spawnSync problem.
vi.mock("../../runtime/container-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime/container-runtime.js")>();
  return {
    ...actual,
    containerServerVersion: vi.fn(),
  };
});

import { spawnSync } from "node:child_process";
import { containerServerVersion } from "../../runtime/container-runtime.js";
import { checkDockerAccessible } from "../checks.js";

const mockedSpawn = vi.mocked(spawnSync);
const mockedServerVersion = vi.mocked(containerServerVersion);

beforeEach(() => {
  process.env.APPBAY_CONTAINER_RUNTIME = "docker";
  process.env.APPBAY_HOME = "/tmp/appbay-sudo-test";
  mockedSpawn.mockReset();
  mockedServerVersion.mockReset();
});

afterEach(() => {
  delete process.env.APPBAY_CONTAINER_RUNTIME;
  delete process.env.APPBAY_HOME;
});

/** Make spawnSync return a successful result with the given stdout. */
function okSpawn(stdout: string) {
  return { status: 0, stdout, stderr: "", error: undefined } as never;
}

/** Make spawnSync return a failed result (non-zero exit). */
function failSpawn() {
  return { status: 1, stdout: "", stderr: "permission denied", error: undefined } as never;
}

describe("checkDockerAccessible — sudo detection", () => {
  it("passes when the current user reaches the daemon without sudo", () => {
    mockedServerVersion.mockReturnValue("29.4.0");
    const result = checkDockerAccessible("/tmp/appbay-sudo-test");
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("server v29.4.0");
    // No sudo probe should have been attempted.
    expect(mockedSpawn).not.toHaveBeenCalledWith("sudo", expect.anything());
  });

  it("reports the needs-sudo case when sudo info succeeds but plain info fails", () => {
    // containerServerVersion returns null → the current user cannot reach the
    // daemon. The sudo probe then succeeds → daemon is up, user lacks access.
    mockedServerVersion.mockReturnValue(null);
    mockedSpawn.mockImplementation((cmd: string) => {
      if (cmd === "sudo") return okSpawn("29.4.0");
      return failSpawn();
    });

    const result = checkDockerAccessible("/tmp/appbay-sudo-test");
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("cannot reach it without sudo");
    // The fix must point at group membership, and must state the escalation
    // boundary (appbay never creates system accounts / sets ACLs).
    expect(result.fix).toContain("usermod -aG docker");
    expect(result.fix).toContain("never creates system accounts or sets ACLs");
  });

  it("reports the daemon-down case when both plain and sudo info fail", () => {
    mockedServerVersion.mockReturnValue(null);
    mockedSpawn.mockImplementation(() => failSpawn());

    const result = checkDockerAccessible("/tmp/appbay-sudo-test");
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("not responding");
    // The fix is the start hint (start the daemon), not group membership.
    expect(result.fix).toContain("Start Docker");
  });
});
