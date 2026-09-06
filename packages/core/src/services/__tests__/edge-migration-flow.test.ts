/**
 * `migrateEdge` is the validate-backup-switch-restore sequence for changing the ingress
 * provider. It had no caller and no test (issue #7); `appbay edge migrate` now calls it.
 * These tests drive it with fakes for the four operations it delegates and pin the two
 * refusals and the rollback, which are the reasons it exists.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateEdge } from "../edge-migration-service.js";

let home: string;

/** The Engine API's `/containers/json` answer for the port check, over a real unix socket. */
interface Row { name: string; ports: number[]; labels?: Record<string, string> }
let rows: Row[] = [];
let sockDir: string; let sock: string; let server: Server;
beforeAll(async () => {
  sockDir = mkdtempSync(join(tmpdir(), "appbay-migrate-sock-"));
  sock = join(sockDir, "engine.sock");
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(rows.map((r, i) => ({
      Id: `id${String(i)}`, Names: [`/${r.name}`], State: "running", Status: "Up", Labels: r.labels ?? {},
      Ports: r.ports.map((p) => ({ PrivatePort: p, PublicPort: p, Type: "tcp" })),
    }))));
  });
  await new Promise<void>((r) => server.listen(sock, r));
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); rmSync(sockDir, { recursive: true, force: true }); });

/** What the runtime reports holding ports; `down` makes the socket unreachable. */
function ps(...r: Row[]): void { rows = r; process.env.APPBAY_RUNTIME_SOCKET = sock; }
function down(): void { process.env.APPBAY_RUNTIME_SOCKET = join(sockDir, "missing.sock"); }
const traefikEdge = (...ports: number[]): Row => ({ name: "appbay.system.traefik.traefik", ports, labels: { "com.appbay.app": "traefik" } });

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
  delete process.env.APPBAY_RUNTIME_SOCKET;
  delete process.env.APPBAY_CONTAINER_RUNTIME;
});

describe("migrateEdge", () => {
  it("refuses when the ports cannot be inspected — it does not migrate blind", async () => {
    down();
    const { opts, calls } = fakes();
    const r = await migrateEdge(opts);
    expect(r.migrated).toBe(false);
    expect(r.steps[0]).toMatchObject({ id: "ports", ok: false });
    expect(r.steps[0]?.detail).toContain("missing.sock");
    expect(calls).toEqual([]);
  });

  it("refuses when a foreign process holds an edge port", async () => {
    ps({ name: "nginx", ports: [80], labels: { "com.docker.compose.project": "other" } });
    const { opts, calls } = fakes();
    const r = await migrateEdge(opts);
    expect(r.migrated).toBe(false);
    expect(r.steps[0]?.detail).toContain(":80 is held by nginx");
    expect(calls).toEqual([]);
  });

  it("validates while the old edge still serves, backs up, then stops, starts and checks", async () => {
    ps(traefikEdge(80, 443));
    const { opts, calls } = fakes();
    const r = await migrateEdge(opts);
    expect(r.migrated).toBe(true);
    expect(calls).toEqual(["validate", "stop traefik", "start caddy", "health caddy"]);
    expect(r.steps.map((s) => s.id)).toEqual(["ports", "validate", "backup", "stop", "start", "health"]);
    const backup = await readFile(join(home, "etc", "apps", "traefik.pre-caddy", "docker-compose.yml"), "utf-8");
    expect(backup).toBe("services: {}\n");
  });

  it("restores the old edge when the new one is unhealthy", async () => {
    ps(traefikEdge(80));
    const { opts, calls } = fakes({ checkHealth: async () => "caddy exited 1" });
    const r = await migrateEdge(opts);
    expect(r.migrated).toBe(false);
    expect(r.restored).toBe(true);
    expect(calls).toEqual(["validate", "stop traefik", "start caddy", "stop caddy", "start traefik"]);
    expect(calls.slice(-2)).toEqual(["stop caddy", "start traefik"]);
    expect(r.steps.find((s) => s.id === "health")).toMatchObject({ ok: false, detail: "caddy exited 1" });
  });

  it("does not stop anything when the candidate fails validation", async () => {
    ps(traefikEdge(80));
    const { opts, calls } = fakes({ validateCandidate: async () => "Caddyfile: unknown directive" });
    const r = await migrateEdge(opts);
    expect(r.migrated).toBe(false);
    expect(calls).toEqual([]);
    expect(r.steps.find((s) => s.id === "validate")).toMatchObject({ ok: false });
  });
});
