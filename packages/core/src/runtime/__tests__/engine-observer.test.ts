/**
 * Observation over the runtime's API socket, against a real HTTP server on a real unix
 * socket that answers the Engine API's shapes. No CLI text is parsed anywhere in here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineObserver, findCrashedServices, isReady } from "../observe.js";
import { apiPing } from "../engine-api.js";

interface Fake { Id: string; Names: string[]; State: string; Status: string; Labels: Record<string, string>; ExitCode?: number }
let containers: Fake[] = [];
let networks = new Set<string>();
let dir: string; let sock: string; let server: Server;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "appbay-engine-"));
  sock = join(dir, "engine.sock");
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/_ping") { res.writeHead(200); res.end("OK"); return; }
    if (url.pathname === "/containers/json") {
      const filters = url.searchParams.get("filters");
      const f = filters ? (JSON.parse(filters) as { label?: string[]; name?: string[] }) : {};
      const out = containers.filter((c) =>
        (f.label ?? []).every((kv) => { const [k, v] = kv.split("="); return c.Labels[k!] === v; }) &&
        (f.name ?? []).every((n) => c.Names.some((x) => x.includes(n))));
      json(200, out.map(({ ExitCode: _e, ...c }) => c)); return;
    }
    const m = /^\/containers\/([^/]+)\/json$/.exec(url.pathname);
    if (m) {
      const c = containers.find((x) => x.Id === decodeURIComponent(m[1]!) || x.Names.includes(`/${decodeURIComponent(m[1]!)}`));
      if (!c) { json(404, { message: "no such container" }); return; }
      json(200, { Id: c.Id, Name: c.Names[0], Image: "img", State: { Running: c.State === "running", Status: c.State, ExitCode: c.ExitCode ?? 0 }, Config: { Image: "img" } }); return;
    }
    const n = /^\/networks\/([^/]+)$/.exec(url.pathname);
    if (n) { networks.has(decodeURIComponent(n[1]!)) ? json(200, { Name: n[1] }) : json(404, { message: "no such network" }); return; }
    json(500, { message: `unexpected ${url.pathname}` });
  });
  await new Promise<void>((r) => server.listen(sock, r));
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });

const obs = () => engineObserver(undefined, sock);
const c = (name: string, state: string, labels: Record<string, string>, extra: Partial<Fake> = {}): Fake =>
  ({ Id: `id-${name}`, Names: [`/${name}`], State: state, Status: state === "running" ? "Up 3 seconds" : "Exited (1) 2 seconds ago", Labels: labels, ...extra });

describe("engine observer", () => {
  it("pings", async () => { expect(await apiPing({ socketPath: sock })).toEqual({ kind: "ok", value: true }); });

  it("finds the edge by its label, whatever its name, preferring the running one", async () => {
    containers = [c("appbay.caddy.caddy", "exited", { "com.appbay.app": "caddy" }), c("appbay.system.caddy.caddy", "running", { "com.appbay.app": "caddy" })];
    expect(await obs().findByLabel("com.appbay.app", "caddy")).toEqual({ kind: "ok", value: { name: "appbay.system.caddy.caddy", state: "running", running: true } });
  });

  it("refuses to pick between two running edges, and reports none as null", async () => {
    containers = [c("a", "running", { "com.appbay.app": "caddy" }), c("b", "running", { "com.appbay.app": "caddy" })];
    expect((await obs().findByLabel("com.appbay.app", "caddy")).kind).toBe("unknown");
    containers = [];
    expect(await obs().findByLabel("com.appbay.app", "caddy")).toEqual({ kind: "ok", value: null });
  });

  it("reads a compose project's rows: service label, health from the status line, exit code by inspect", async () => {
    containers = [
      c("app-web-1", "running", { "com.docker.compose.project": "app", "com.docker.compose.service": "web" }, { Status: "Up 9 seconds (healthy)" }),
      c("app-job-1", "exited", { "com.docker.compose.project": "app", "com.docker.compose.service": "job" }, { ExitCode: 137 }),
      c("other-1", "running", { "com.docker.compose.project": "other" }),
    ];
    const rows = await obs().project("app");
    expect(rows.kind).toBe("ok");
    if (rows.kind !== "ok") return;
    expect(rows.value.map((r) => [r.service, r.state, r.health, r.exitCode])).toEqual([["web", "running", "healthy", 0], ["job", "exited", "", 137]]);
    expect(await findCrashedServices(obs(), "app")).toEqual({ kind: "ok", value: ["job exited 137"] });
    const ready = await isReady(obs(), "app");
    expect(ready).toMatchObject({ kind: "ok", value: { ready: false } });
  });

  it("answers running-state and network existence", async () => {
    containers = [c("appbay.server", "running", {})]; networks = new Set(["appbay_shared"]);
    const o = obs();
    expect(await o.networkExists("appbay_shared")).toEqual({ kind: "ok", value: true });
    expect(await o.networkExists("nope")).toEqual({ kind: "ok", value: false });
  });

  it("is unknown, naming the socket, when there is no socket", async () => {
    const r = await engineObserver(undefined, join(dir, "absent.sock")).project("app");
    expect(r.kind).toBe("unknown");
    if (r.kind === "unknown") expect(r.reason).toContain("absent.sock");
  });
});
