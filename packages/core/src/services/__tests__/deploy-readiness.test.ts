/**
 * Declared order is executed order. Two apps, `db` in project `data` and `web` in project
 * `app` with `after: [data]`: web does not start until db is READY, readiness is observed
 * from compose ps (running, and healthy where a healthcheck exists), the wait is bounded, and
 * a timeout fails db and skips web with the reason instead of proceeding.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploy } from "../deploy-service.js";
import type { ComposePsRow, DockerComposeRunner, Observer } from "../../runtime/observe.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "appbay-readiness-"));
  for (const [name, collection] of [["db", "data"], ["web", "app"]] as const) {
    const dir = join(home, "etc", "apps", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "docker-compose.yml"), `services:\n  ${name}:\n    image: ${name}:latest\n`);
    await writeFile(join(dir, "appbay.yaml"), `project: ${collection}\n`);
  }
  await mkdir(join(home, "etc"), { recursive: true });
  await writeFile(join(home, "etc", "projects.yaml"), "projects:\n  app:\n    after: [data]\n");
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const row = (name: string, state: string, health = ""): ComposePsRow =>
  ({ name: `appbay.${name}.${name}`, id: "id", service: name, state, status: state, ports: "", health, exitCode: 0 });

/** A compose runner that records mutations, and an observer whose answers per project depend on how often it was asked. */
function runner(answers: Record<string, (n: number) => ComposePsRow | ComposePsRow[]>): { run: DockerComposeRunner; observer: Observer; log: string[] } {
  const asked: Record<string, number> = {};
  const log: string[] = [];
  const run: DockerComposeRunner = (subArgs, composePath) => {
    const app = composePath.includes("/db/") ? "db" : "web";
    log.push(`${app}:${subArgs[0]}`);
    return { exitCode: 0, output: "" };
  };
  const observer: Observer = {
    project: async (app) => { log.push(`${app}:ps`); asked[app] = (asked[app] ?? 0) + 1; return { kind: "ok", value: [answers[app]!(asked[app]!)].flat() }; },
    findByLabel: async () => ({ kind: "ok", value: null }),
    networkExists: async () => ({ kind: "ok", value: true }),
  };
  return { run, observer, log };
}
const noSleep = async () => {};

describe("readiness gating", () => {
  it("starts web only after db is running AND healthy", async () => {
    const { run, observer, log } = runner({
      db: (n) => row("db", "running", n < 3 ? "starting" : "healthy"),
      web: () => row("web", "running"),
    });
    const r = await deploy({ appbayHome: home, dockerCompose: run, observer, readinessTimeoutMs: 10_000, sleep: noSleep });
    expect(r.failed).toBe(0);
    expect(r.deployed).toBe(2);
    const firstWebUp = log.indexOf("web:up");
    const dbPsBeforeWeb = log.slice(0, firstWebUp).filter((l) => l === "db:ps").length;
    expect(dbPsBeforeWeb).toBeGreaterThanOrEqual(3);
  });

  it("a service with no healthcheck is ready when it runs", async () => {
    const { run, observer } = runner({ db: () => row("db", "running"), web: () => row("web", "running") });
    const r = await deploy({ appbayHome: home, dockerCompose: run, observer, readinessTimeoutMs: 10_000, sleep: noSleep });
    expect(r.deployed).toBe(2);
  });

  it("fails db on timeout and SKIPS web with the reason, never proceeding", async () => {
    const { run, observer, log } = runner({ db: () => row("db", "running", "starting"), web: () => row("web", "running") });
    const r = await deploy({ appbayHome: home, dockerCompose: run, observer, readinessTimeoutMs: 1, sleep: noSleep });
    expect(r.deployed).toBe(0);
    expect(r.failed).toBe(2);
    const db = r.apps.find((a) => a.appName === "db")!;
    const web = r.apps.find((a) => a.appName === "web")!;
    expect(db.error).toMatch(/not ready within \d+s: db is running \(starting\)/);
    // db's container is up and never became ready: a partial converge, counted as one (S48).
    expect(db.containerStartedWithoutRoutes).toBe(true);
    expect(r.startedButUnrouted).toBe(1);
    expect(web.error).toContain("skipped: depends on db, which did not become ready");
    expect(log).not.toContain("web:up");
  });

  it("a container that dies during the readiness wait is a crash, not 'up and not ready' (S48 round 2)", async () => {
    const { run, observer } = runner({
      // before, after, crash check: running; from the readiness probe on: exited 1
      db: (n) => (n <= 3 ? row("db", "running") : { ...row("db", "exited"), exitCode: 1 }),
      web: () => row("web", "running"),
    });
    const r = await deploy({ appbayHome: home, dockerCompose: run, observer, readinessTimeoutMs: 1, sleep: noSleep, crashGraceMs: 0 });
    const db = r.apps.find((a) => a.appName === "db")!;
    expect(db.status).toBe("failed");
    expect(db.error).toContain("exited");
    expect(db.containerStartedWithoutRoutes).toBeUndefined();
    expect(r.startedButUnrouted).toBe(0);
  });

  it("a readiness probe the runtime cannot answer is unobservable, not a timeout (S48)", async () => {
    const { run, observer, log } = runner({ db: () => row("db", "running"), web: () => row("web", "running") });
    const project = observer.project;
    let asks = 0;
    // before, up, after, crash check answer; the readiness probe (the fourth ask) does not.
    observer.project = async (app) => app === "db" && ++asks > 3 ? { kind: "unknown", reason: "socket closed" } : project(app);
    const r = await deploy({ appbayHome: home, dockerCompose: run, observer, readinessTimeoutMs: 10_000, sleep: noSleep, crashGraceMs: 0 });
    const db = r.apps.find((a) => a.appName === "db")!;
    expect(db).toMatchObject({ status: "unchanged", convergeAction: "unknown", unknownReason: "socket closed" });
    expect(db.error).toBeUndefined();
    expect(log).not.toContain("web:up");
  });

  it("a dependency whose edge route did not land blocks its dependent: every failure blocks (F2, S48)", async () => {
    // db declares an ingress route; no edge is running, so its route link diverges after its
    // project converged. web must not start over it.
    await writeFile(join(home, "etc", "apps", "db", "appbay.yaml"), "project: data\ntraits:\n  - type: ingress\n    host: db.example.test\n    port: 80\n    service: db\n");
    const { run, observer, log } = runner({ db: () => row("db", "running"), web: () => row("web", "running") });
    const r = await deploy({ appbayHome: home, dockerCompose: run, observer, readinessTimeoutMs: 10_000, sleep: noSleep, crashGraceMs: 0 });
    const db = r.apps.find((a) => a.appName === "db")!;
    const web = r.apps.find((a) => a.appName === "web")!;
    expect(r.compileErrors).toEqual([]);
    expect(db).toMatchObject({ status: "failed", containerStartedWithoutRoutes: true });
    expect(web.error).toContain("depends on db, which did not become ready");
    expect(log).toContain("db:up");
    expect(log).not.toContain("web:up");
  });

  it("refuses the whole run, before anything starts, when projects.yaml has a cycle", async () => {
    await writeFile(join(home, "etc", "projects.yaml"), "projects:\n  app:\n    after: [data]\n  data:\n    after: [app]\n");
    const { run, observer, log } = runner({ db: () => row("db", "running"), web: () => row("web", "running") });
    const r = await deploy({ appbayHome: home, dockerCompose: run, observer, sleep: noSleep });
    expect(r.compileErrors.map((e) => e.stage)).toContain("projects");
    expect(r.compileErrors.map((e) => e.message).join("\n")).toMatch(/cycle/);
    expect(log.filter((l) => l.endsWith(":up"))).toEqual([]);
  });
});

describe("readiness after the 2026-09-06 review", () => {
  it("a one-shot init service that exited 0 does not hold its app back (F4)", async () => {
    const { run, observer, log } = runner({
      db: () => [row("db", "running"), { ...row("db-init", "exited"), exitCode: 0 }],
      web: () => row("web", "running"),
    });
    const r = await deploy({ appbayHome: home, dockerCompose: run, observer, readinessTimeoutMs: 10_000, sleep: noSleep, crashGraceMs: 0 });
    expect(r.failed).toBe(0);
    expect(r.deployed).toBe(2);
    expect(log).toContain("web:up");
  });

  it("a dependency whose runtime could not be observed blocks its dependent (S47)", async () => {
    // db's socket is down; web's is fine. Nothing starts over a dependency nobody saw ready.
    const { run, observer, log } = runner({ db: () => row("db", "running"), web: () => row("web", "running") });
    const project = observer.project;
    observer.project = async (app) => app === "db" ? { kind: "unknown", reason: "no socket" } : project(app);
    const r = await deploy({ appbayHome: home, dockerCompose: run, observer, readinessTimeoutMs: 10_000, sleep: noSleep, crashGraceMs: 0 });
    const db = r.apps.find((a) => a.appName === "db")!;
    const web = r.apps.find((a) => a.appName === "web")!;
    expect(db).toMatchObject({ status: "unchanged", convergeAction: "unknown", unknownReason: "no socket" });
    expect(web.status).toBe("failed");
    expect(web.error).toContain("depends on db, which did not become ready");
    expect(log).not.toContain("web:up");
    expect([r.deployed, r.unchanged, r.failed]).toEqual([0, 1, 1]);
  });

  it("a dependency that did not compile blocks its dependent, like one that did not become ready (F2)", async () => {
    // An ingress trait with no host and no domain is a compile error that keeps db in the app
    // set (a manifest that fails to parse drops out of the graph and refuses the whole run).
    await writeFile(join(home, "etc", "apps", "db", "appbay.yaml"), "project: data\ntraits:\n  - type: ingress\n    port: 80\n    service: db\n");
    const { run, observer, log } = runner({ db: () => row("db", "running"), web: () => row("web", "running") });
    const r = await deploy({ appbayHome: home, dockerCompose: run, observer, readinessTimeoutMs: 10_000, sleep: noSleep, crashGraceMs: 0 });
    const web = r.apps.find((a) => a.appName === "web");
    expect(web?.status).toBe("failed");
    expect(web?.error).toContain("depends on db");
    expect(log).not.toContain("web:up");
  });
});
