/**
 * Who holds :80 and :443 — `inspectEdgePorts` / `blockingPortConflicts`, answered over the
 * Engine API against a real unix-socket server (S41's harness).
 *
 * ⭐ Two ways to be wrong, opposite costs: miss a real holder and the migration proceeds into
 * a bind failure that `compose up -d` reports as success; flag the outgoing edge and the
 * migration refuses to run at all, forever. The second is what the `ps --format` text parser
 * did on Podman, whose `{{.Labels}}` renders as `map[k:v]`, not `k=v,` (issue #9).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockingPortConflicts, inspectEdgePorts } from "../edge-migration-service.js";

interface Fake { Names: string[]; State: string; Labels: Record<string, string>; Ports: Array<{ PrivatePort: number; PublicPort?: number; Type: string }> }
let containers: Fake[] = [];
let dir: string; let sock: string; let server: Server;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "appbay-ports-"));
  sock = join(dir, "engine.sock");
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(containers.map((c, i) => ({ Id: `id${String(i)}`, Status: c.State === "running" ? "Up" : "Exited (0)", ...c }))));
  });
  await new Promise<void>((r) => server.listen(sock, r));
  process.env.APPBAY_RUNTIME_SOCKET = sock;
});
afterAll(async () => { delete process.env.APPBAY_RUNTIME_SOCKET; await new Promise<void>((r) => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });

const edge = (app: string, state = "running"): Fake => ({
  Names: [`/appbay.system.${app}.${app}`], State: state, Labels: { "com.appbay.app": app, "com.appbay.namespace": "system" },
  Ports: [{ PrivatePort: 80, PublicPort: 80, Type: "tcp" }, { PrivatePort: 443, PublicPort: 443, Type: "tcp" }, { PrivatePort: 443, Type: "udp" }],
});

async function owners(outgoing: "caddy" | "traefik") {
  const r = await inspectEdgePorts(outgoing);
  if (r.kind !== "ok") throw new Error(r.reason);
  return r.value;
}

describe("inspectEdgePorts over the API", () => {
  it("the outgoing edge holding both ports is expected, not a conflict, whatever its name", async () => {
    containers = [edge("caddy")];
    const o = await owners("caddy");
    expect(o).toEqual([
      { port: 80, heldBy: "appbay.system.caddy.caddy", isOutgoingEdge: true },
      { port: 443, heldBy: "appbay.system.caddy.caddy", isOutgoingEdge: true },
    ]);
    expect(blockingPortConflicts(o)).toEqual([]);
  });

  it("a foreign holder is a conflict named by its container", async () => {
    containers = [{ Names: ["/nginx"], State: "running", Labels: {}, Ports: [{ PrivatePort: 80, PublicPort: 80, Type: "tcp" }] }];
    const o = await owners("caddy");
    expect(blockingPortConflicts(o)).toEqual([{ port: 80, heldBy: "nginx", isOutgoingEdge: false }]);
  });

  it("the other edge holding the ports is a conflict too: the label must equal the outgoing provider", async () => {
    containers = [edge("traefik")];
    expect(blockingPortConflicts(await owners("caddy"))).toHaveLength(2);
  });

  it(":8080 is not :80, and an exited container holds nothing", async () => {
    containers = [
      { Names: ["/dash"], State: "running", Labels: {}, Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: "tcp" }] },
      edge("caddy", "exited"),
    ];
    expect((await owners("caddy")).every((p) => p.heldBy === null)).toBe(true);
  });

  it("an unreachable socket is unknown, never 'free'", async () => {
    process.env.APPBAY_RUNTIME_SOCKET = join(dir, "missing.sock");
    const r = await inspectEdgePorts("caddy");
    process.env.APPBAY_RUNTIME_SOCKET = sock;
    expect(r.kind).toBe("unknown");
  });
});
