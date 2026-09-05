/**
 * Declared order is executed order (S39 R1, R2). Two apps, `db` in `data` and `web` in
 * `app` with `after: [data]`: web does not start until db is READY, readiness is observed
 * from compose ps (running, and healthy where a healthcheck exists), the wait is bounded, and
 * a timeout fails db and skips web with the reason instead of proceeding.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploy } from "../deploy-service.js";
import type { DockerComposeRunner } from "../../runtime/observe.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "appbay-readiness-"));
  for (const [name, collection] of [["db", "data"], ["web", "app"]] as const) {
    const dir = join(home, "etc", "apps", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "docker-compose.yml"), `services:\n  ${name}:\n    image: ${name}:latest\n`);
    await writeFile(join(dir, "appbay.yaml"), `collection: [${collection}]\n`);
  }
  await mkdir(join(home, "etc"), { recursive: true });
  await writeFile(join(home, "etc", "collections.yaml"), "collections:\n  app:\n    after: [data]\n");
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const row = (name: string, state: string, health = "") =>
  JSON.stringify({ ID: "id", Name: `appbay.${name}.${name}`, Service: name, State: state, Health: health, ExitCode: 0 });

/** A runner whose `ps` answers per project depend on how many times that project was asked. */
function runner(answers: Record<string, (n: number) => string>): DockerComposeRunner & { log: string[] } {
  const asked: Record<string, number> = {};
  const log: string[] = [];
  const run = ((subArgs: string[], composePath: string) => {
    const app = composePath.includes("/db/") ? "db" : "web";
    log.push(`${app}:${subArgs[0]}`);
    if (subArgs[0] === "ps") { asked[app] = (asked[app] ?? 0) + 1; return { exitCode: 0, output: answers[app]!(asked[app]!) }; }
    return { exitCode: 0, output: "" };
  }) as DockerComposeRunner & { log: string[] };
  run.log = log;
  return run;
}
const noSleep = async () => {};

describe("readiness gating", () => {
  it("starts web only after db is running AND healthy", async () => {
    const run = runner({
      db: (n) => row("db", "running", n < 3 ? "starting" : "healthy"),
      web: () => row("web", "running"),
    });
    const r = await deploy({ appbayHome: home, dockerCompose: run, readinessTimeoutMs: 10_000, sleep: noSleep });
    expect(r.failed).toBe(0);
    expect(r.deployed).toBe(2);
    const firstWebUp = run.log.indexOf("web:up");
    const dbPsBeforeWeb = run.log.slice(0, firstWebUp).filter((l) => l === "db:ps").length;
    expect(dbPsBeforeWeb).toBeGreaterThanOrEqual(3);
  });

  it("a service with no healthcheck is ready when it runs", async () => {
    const run = runner({ db: () => row("db", "running"), web: () => row("web", "running") });
    const r = await deploy({ appbayHome: home, dockerCompose: run, readinessTimeoutMs: 10_000, sleep: noSleep });
    expect(r.deployed).toBe(2);
  });

  it("fails db on timeout and SKIPS web with the reason, never proceeding", async () => {
    const run = runner({ db: () => row("db", "running", "starting"), web: () => row("web", "running") });
    const r = await deploy({ appbayHome: home, dockerCompose: run, readinessTimeoutMs: 1, sleep: noSleep });
    expect(r.deployed).toBe(0);
    expect(r.failed).toBe(2);
    const db = r.apps.find((a) => a.appName === "db")!;
    const web = r.apps.find((a) => a.appName === "web")!;
    expect(db.error).toMatch(/not ready within \d+s: db is running \(starting\)/);
    expect(web.error).toContain("skipped: depends on db, which did not become ready");
    expect(run.log).not.toContain("web:up");
  });

  it("refuses the whole run, before anything starts, when collections.yaml has a cycle", async () => {
    await writeFile(join(home, "etc", "collections.yaml"), "collections:\n  app:\n    after: [data]\n  data:\n    after: [app]\n");
    const run = runner({ db: () => row("db", "running"), web: () => row("web", "running") });
    const r = await deploy({ appbayHome: home, dockerCompose: run, sleep: noSleep });
    expect(r.compileErrors.map((e) => e.stage)).toContain("collections");
    expect(r.compileErrors.map((e) => e.message).join("\n")).toMatch(/cycle/);
    expect(run.log.filter((l) => l.endsWith(":up"))).toEqual([]);
  });
});
