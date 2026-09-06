/**
 * On traefik the route is a file the edge watches, so "installed" was a write and nothing
 * else: `appbay up` said deployed with no traefik running (review 2026-09-05, F1). The
 * install now observes the edge before saying so.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRoute } from "../deploy-service.js";
import type { ContainerMatch, Observer } from "../../runtime/observe.js";
import type { Inspection } from "../../runtime/container-runtime.js";

const savedProvider = process.env.APPBAY_INGRESS_PROVIDER;
let home: string;
beforeEach(async () => { process.env.APPBAY_INGRESS_PROVIDER = "traefik"; home = await mkdtemp(join(tmpdir(), "appbay-route-")); });
afterEach(async () => {
  if (savedProvider === undefined) delete process.env.APPBAY_INGRESS_PROVIDER;
  else process.env.APPBAY_INGRESS_PROVIDER = savedProvider;
  await rm(home, { recursive: true, force: true });
});

const app = { auxiliaryFiles: [{ path: "etc/apps/traefik/config/dynamic/whoami.yml", content: "http: {}" }] };
const edge = (r: Inspection<ContainerMatch | null>, onAsk?: () => void): Observer => ({
  findByLabel: async () => { onAsk?.(); return r; },
  project: async () => ({ kind: "ok", value: [] }),
  networkExists: async () => ({ kind: "ok", value: true }),
});

describe("installRoute on traefik", () => {
  it("is ok when a running traefik carries the label, and the fragment is written then", async () => {
    const r = await installRoute(app, home, edge({ kind: "ok", value: { name: "appbay.system.traefik.traefik", state: "running", running: true } }));
    expect(r).toEqual({ ok: true });
    expect(await readFile(join(home, app.auxiliaryFiles[0]!.path), "utf-8")).toBe("http: {}");
  });

  it("is unavailable when no traefik is deployed, and writes nothing traefik would later pick up", async () => {
    const r = await installRoute(app, home, edge({ kind: "ok", value: null }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unavailable");
    expect(r.detail).toContain("com.appbay.app=traefik");
    expect(existsSync(join(home, app.auxiliaryFiles[0]!.path))).toBe(false);
  });

  it("is unavailable when traefik exists but is stopped", async () => {
    const r = await installRoute(app, home, edge({ kind: "ok", value: { name: "appbay.system.traefik.traefik", state: "exited", running: false } }));
    expect(r).toMatchObject({ ok: false, reason: "unavailable" });
    expect(r.detail).toContain("exited");
  });

  it("is unavailable, with the reason, when the runtime could not be asked", async () => {
    const r = await installRoute(app, home, edge({ kind: "unknown", reason: "daemon down" }));
    expect(r).toMatchObject({ ok: false, reason: "unavailable" });
    expect(r.detail).toContain("daemon down");
  });

  it("does nothing for an app with no route files", async () => {
    let asked = false;
    const r = await installRoute({ auxiliaryFiles: [] }, home, edge({ kind: "ok", value: null }, () => { asked = true; }));
    expect(r).toEqual({ ok: true });
    expect(asked).toBe(false);
  });
});
