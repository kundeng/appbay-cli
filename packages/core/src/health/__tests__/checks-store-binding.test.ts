/**
 * Tests for `checkStoreBinding` — #58 R3.
 *
 * The defect: `container_runtime: podman` matched while the STORE did not.
 * Rootful and rootless podman keep separate stores, so an install created by an
 * ordinary user put `appbay_shared` in ~/.local/share/containers/storage while
 * `sudo appbay up` looked in /var/lib/containers/storage and reported
 * `External network [appbay_shared] does not exists`.
 *
 * Four outcomes, and the last two are the ones that keep this from being a
 * check that only ever says yes:
 *
 *   recorded == live      pass
 *   recorded != live      FAIL, required
 *   nothing recorded      pass — an install predating the key was never asked
 *   runtime not answering pass — runtime-access owns that verdict
 *
 * ⚠️ Mocks `../../runtime/container-runtime.js`, the module checks.ts actually
 * imports — NOT the package barrel. checks.ts never goes through its own barrel,
 * so a barrel mock intercepts nothing and the real function runs against the
 * developer's own docker. That exact mistake is documented in checks-sudo.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../runtime/container-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime/container-runtime.js")>();
  return { ...actual, containerStoreRoot: vi.fn() };
});

import { containerStoreRoot } from "../../runtime/container-runtime.js";
import { checkStoreBinding } from "../checks.js";

const mockedStoreRoot = vi.mocked(containerStoreRoot);

const ROOTFUL = "/var/lib/containers/storage";
const ROOTLESS = "/home/ubuntu/.local/share/containers/storage";

let home: string;

/** Write a project.yaml, optionally carrying a recorded store binding. */
function install(store?: string): string {
  writeFileSync(
    join(home, "project.yaml"),
    `project: homelab\ndomain: local\ncontainer_runtime: podman\n` +
      (store ? `container_store: ${store}\n` : ""),
    "utf-8",
  );
  return home;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "appbay-store-binding-"));
  mkdirSync(join(home, "etc"), { recursive: true });
  process.env.APPBAY_CONTAINER_RUNTIME = "podman";
  mockedStoreRoot.mockReset();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.APPBAY_CONTAINER_RUNTIME;
});

describe("checkStoreBinding", () => {
  it("passes when the live store is the one recorded at init", () => {
    install(ROOTFUL);
    mockedStoreRoot.mockReturnValue(ROOTFUL);

    const result = checkStoreBinding(home);
    expect(result.passed).toBe(true);
    expect(result.detail).toBe(ROOTFUL);
  });

  it("FAILS when init bound rootless but this shell reaches rootful", () => {
    // The exact #58 R3 scenario: `appbay init` as an ordinary user, then `sudo appbay up`.
    install(ROOTLESS);
    mockedStoreRoot.mockReturnValue(ROOTFUL);

    const result = checkStoreBinding(home);
    expect(result.passed).toBe(false);
    expect(result.required).toBe(true);
    // Both paths must appear — a mismatch message naming only one of them leaves the
    // operator unable to tell which way round it is.
    expect(result.detail).toContain(ROOTLESS);
    expect(result.detail).toContain(ROOTFUL);
  });

  it("FAILS symmetrically in the other direction", () => {
    install(ROOTFUL);
    mockedStoreRoot.mockReturnValue(ROOTLESS);

    const result = checkStoreBinding(home);
    expect(result.passed).toBe(false);
  });

  it("names sudo in the fix on podman, because that IS the other store", () => {
    install(ROOTLESS);
    mockedStoreRoot.mockReturnValue(ROOTFUL);

    const result = checkStoreBinding(home);
    expect(result.fix).toContain("sudo");
    expect(result.fix).toContain("appbay init");
    // It must not promise a migration it does not perform.
    expect(result.fix).toContain("will not move");
  });

  it("does NOT mention sudo on docker — that advice goes nowhere there", () => {
    process.env.APPBAY_CONTAINER_RUNTIME = "docker";
    writeFileSync(
      join(home, "project.yaml"),
      `project: homelab\ndomain: local\ncontainer_store: /var/lib/docker\n`,
      "utf-8",
    );
    mockedStoreRoot.mockReturnValue("/mnt/big/docker");

    const result = checkStoreBinding(home);
    expect(result.passed).toBe(false);
    expect(result.fix).toContain("DOCKER_HOST");
    expect(result.fix).not.toContain("sudo");
  });

  it("passes when nothing is recorded — an old install was never asked", () => {
    install(); // no container_store key
    mockedStoreRoot.mockReturnValue(ROOTFUL);

    const result = checkStoreBinding(home);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("not recorded");
    // Failing this closed would break every existing homelab on upgrade.
  });

  it("does not probe the runtime at all when nothing is recorded", () => {
    install();
    checkStoreBinding(home);
    // Nothing to compare against, so spawning `podman info` is pure cost on a host
    // whose daemon may be down.
    expect(mockedStoreRoot).not.toHaveBeenCalled();
  });

  it("passes when the runtime is not answering — runtime-access owns that", () => {
    install(ROOTFUL);
    mockedStoreRoot.mockReturnValue(null);

    const result = checkStoreBinding(home);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("runtime-access");
    // Reporting one outage under two names sends the operator hunting a second fault.
  });

  it("passes when there is no project.yaml at all", () => {
    // Uninitialised install — `appbay-home` reports that, not this check.
    const result = checkStoreBinding(home);
    expect(result.passed).toBe(true);
  });
});
