/**
 * `migrateEdge` is the validate-backup-switch-restore sequence for changing the ingress
 * provider. It had no caller and no test (issue #7); `appbay edge migrate` now calls it.
 * These tests drive it with fakes for the four operations it delegates and pin the two
 * refusals and the rollback, which are the reasons it exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawnSync: vi.fn() };
});
import { spawnSync } from "node:child_process";
import { migrateEdge } from "../edge-migration-service.js";

const mockedSpawn = vi.mocked(spawnSync);
let home: string;

/** What `ps --format {{.Names}}\t{{.Ports}}\t{{.Labels}}` answers. */
function ps(lines: string, status = 0): void {
  mockedSpawn.mockReturnValue({ status, stdout: lines, stderr: status === 0 ? "" : "no daemon", error: undefined } as never);
}

function fakes(overrides: Partial<Parameters<typeof migrateEdge>[0]> = {}) {
  const calls: string[] = [];
  return {
    calls,
    opts: {
      appbayHome: home,
      from: "traefik" as const,
      to: "caddy" as const,
      validateCandidate: async () => { calls.push("validate"); return null; },
      stopStack: async (p: string) => { calls.push(`stop ${p}`); },
      startStack: async (p: string) => { calls.push(`start ${p}`); },
      checkHealth: async (p: string) => { calls.push(`health ${p}`); return null; },
      ...overrides,
    },
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "appbay-migrate-"));
  await mkdir(join(home, "etc", "apps", "traefik"), { recursive: true });
  await writeFile(join(home, "etc", "apps", "traefik", "docker-compose.yml"), "services: {}\n");
  process.env.APPBAY_CONTAINER_RUNTIME = "docker";
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  mockedSpawn.mockReset();
  delete process.env.APPBAY_CONTAINER_RUNTIME;
});

describe("migrateEdge", () => {
  it("refuses when the ports cannot be inspected — it does not migrate blind", async () => {
    ps("", 1);
    const { opts, calls } = fakes();
    const r = await migrateEdge(opts);
    expect(r.migrated).toBe(false);
    expect(r.steps[0]).toMatchObject({ id: "ports", ok: false });
    expect(r.steps[0]?.detail).toContain("no daemon");
    expect(calls).toEqual([]);
  });

  it("refuses when a foreign process holds an edge port", async () => {
    ps("nginx\t0.0.0.0:80->80/tcp\tcom.docker.compose.project=other");
    const { opts, calls } = fakes();
    const r = await migrateEdge(opts);
    expect(r.migrated).toBe(false);
    expect(r.steps[0]?.detail).toContain(":80 is held by nginx");
    expect(calls).toEqual([]);
  });

  it("validates while the old edge still serves, backs up, then stops, starts and checks", async () => {
    ps("appbay.system.traefik.traefik\t0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp\tcom.appbay.app=traefik");
    const { opts, calls } = fakes();
    const r = await migrateEdge(opts);
    expect(r.migrated).toBe(true);
    expect(calls).toEqual(["validate", "stop traefik", "start caddy", "health caddy"]);
    expect(r.steps.map((s) => s.id)).toEqual(["ports", "validate", "backup", "stop", "start", "health"]);
    const backup = await readFile(join(home, "etc", "apps", "traefik.pre-caddy", "docker-compose.yml"), "utf-8");
    expect(backup).toBe("services: {}\n");
  });

  it("restores the old edge when the new one is unhealthy", async () => {
    ps("appbay.system.traefik.traefik\t0.0.0.0:80->80/tcp\tcom.appbay.app=traefik");
    const { opts, calls } = fakes({ checkHealth: async () => "caddy exited 1" });
    const r = await migrateEdge(opts);
    expect(r.migrated).toBe(false);
    expect(r.restored).toBe(true);
    expect(calls).toEqual(["validate", "stop traefik", "start caddy", "stop caddy", "start traefik"]);
    expect(calls.slice(-2)).toEqual(["stop caddy", "start traefik"]);
    expect(r.steps.find((s) => s.id === "health")).toMatchObject({ ok: false, detail: "caddy exited 1" });
  });

  it("does not stop anything when the candidate fails validation", async () => {
    ps("appbay.system.traefik.traefik\t0.0.0.0:80->80/tcp\tcom.appbay.app=traefik");
    const { opts, calls } = fakes({ validateCandidate: async () => "Caddyfile: unknown directive" });
    const r = await migrateEdge(opts);
    expect(r.migrated).toBe(false);
    expect(calls).toEqual([]);
    expect(r.steps.find((s) => s.id === "validate")).toMatchObject({ ok: false });
  });
});
