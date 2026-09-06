/**
 * The deploy path reports what it observed (appbay-cli#4, #5). Observation is an
 * `Observer` fed here with rows directly; mutation is a compose runner that records calls.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploy } from "../deploy-service.js";
import { findCrashedServices, type ComposePsRow, type DockerComposeRunner, type Observer } from "../../runtime/observe.js";
import type { Inspection } from "../../runtime/container-runtime.js";

let home: string;
const APP = "whoami";
const CONTAINER = `appbay.${APP}.${APP}`;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "appbay-converge-"));
  const appDir = join(home, "etc", "apps", APP);
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "docker-compose.yml"), `services:\n  ${APP}:\n    image: traefik/whoami\n`);
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const row = (state: string, id = "id-1", exitCode = 0): ComposePsRow =>
  ({ name: CONTAINER, id, service: APP, state, status: state, ports: "", health: "", exitCode });

/** An observer answering `project()` from a queue, one entry per ask, repeating the last. */
function observerWith(answers: Array<Inspection<ComposePsRow[]>>): Observer {
  let i = 0;
  return {
    project: async () => answers[Math.min(i++, answers.length - 1)] ?? { kind: "unknown", reason: "no answer" },
    findByLabel: async () => ({ kind: "ok", value: null }),
    networkExists: async () => ({ kind: "ok", value: true }),
  };
}
const ok = (...rows: ComposePsRow[]): Inspection<ComposePsRow[]> => ({ kind: "ok", value: rows });
const unknown = (reason: string): Inspection<ComposePsRow[]> => ({ kind: "unknown", reason });
const composeCalls: string[][] = [];
const compose: DockerComposeRunner = (subArgs) => { composeCalls.push(subArgs); return { exitCode: 0, output: "" }; };

async function seedRender(): Promise<void> {
  await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([ok(row("running", "seed-id"))]) });
}

describe("🚨 an UNCHANGED artifact does not mean an unchanged deployment", () => {
  it("a container that was gone and is now created counts as DEPLOYED", async () => {
    await seedRender();
    // later deploys ask: before-snapshot, after-snapshot, crash check
    const result = await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([ok(), ok(row("running", "new-id")), ok(row("running", "new-id"))]) });
    expect(result.apps[0]?.planStatus).toBe("unchanged");
    expect(result.deployed).toBe(1);
    expect(result.unchanged).toBe(0);
  });

  it("already running, same id, is the one genuinely unchanged case", async () => {
    await seedRender();
    const running = ok(row("running", "same-id"));
    const result = await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([running, running, running]) });
    expect(result.unchanged).toBe(1);
    expect(result.deployed).toBe(0);
  });

  it("a RECREATED container — same name, new id — is deployed", async () => {
    await seedRender();
    const result = await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([ok(row("running", "old-id")), ok(row("running", "new-id")), ok(row("running", "new-id"))]) });
    expect(result.deployed).toBe(1);
    expect(result.unchanged).toBe(0);
  });
});

describe("what compose did is recorded on every plan status (S47)", () => {
  it("a NEW plan records that compose started something, and is deployed", async () => {
    // before: nothing; after and crash check: running
    const result = await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([ok(), ok(row("running", "new-id"))]) });
    expect(result.apps[0]).toMatchObject({ planStatus: "new", status: "deployed", convergeAction: "started" });
  });

  it("the render's .env is a copy of the app's on an unchanged plan too", async () => {
    await seedRender();
    await writeFile(join(home, "etc", "apps", APP, ".env"), "ROTATED=1\n");
    const result = await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([ok(row("running", "seed-id"))]) });
    expect(result.apps[0]?.planStatus).toBe("unchanged");
    expect(await readFile(join(home, "var", "lib", "renders", APP, ".env"), "utf-8")).toBe("ROTATED=1\n");
  });
});

describe("a target nothing matches is named, not dropped (S48 round 3)", () => {
  it("names the unknown app and deploys nothing", async () => {
    const result = await deploy({ appbayHome: home, targetApps: [APP, "typo"], dockerCompose: compose, crashGraceMs: 0, observer: observerWith([ok(row("running"))]) });
    expect(result.apps).toEqual([]);
    expect(result.compileErrors).toEqual([{ appName: "typo", stage: "target", message: 'no installed app named "typo"' }]);
  });

  it("compose is told the project name: a `name:` in the upstream or COMPOSE_PROJECT_NAME cannot move it (S48 round 7)", async () => {
    composeCalls.length = 0;
    await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([ok(row("running"))]) });
    expect(composeCalls).toEqual([["-p", APP, "up", "-d"]]);
    // A name compose would refuse as a -p value goes through the same normalization compose applied to the directory.
    const { composeProject } = await import("../../compiler/identity.js");
    expect(composeProject("Whoami.Two")).toBe("whoamitwo");
  });

  it("a clean up -d that left no container under the project is a failure, not 'already running' (S48 round 8)", async () => {
    const result = await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([ok()]) });
    expect(result.apps[0]?.status).toBe("failed");
    expect(result.apps[0]?.error).toContain("started nothing");
  });

  it("two apps that would share a compose project are refused before anything runs (S48 round 9)", async () => {
    const twin = join(home, "etc", "apps", "who.ami");
    await mkdir(twin, { recursive: true });
    await writeFile(join(twin, "docker-compose.yml"), "services:\n  x:\n    image: traefik/whoami\n");
    const result = await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([ok(row("running"))]) });
    expect(result.apps).toEqual([]);
    expect(result.compileErrors.map((e) => e.message).join("\n")).toContain('share the compose project "whoami"');
    await rm(twin, { recursive: true, force: true });
  });

  it("an empty target list deploys nothing, not everything", async () => {
    const result = await deploy({ appbayHome: home, targetApps: [], dockerCompose: compose, crashGraceMs: 0, observer: observerWith([ok(row("running"))]) });
    expect(result.apps).toEqual([]);
    expect(result.compileErrors).toEqual([]);
  });
});

describe("🚨 a service that starts and immediately dies is NOT a success", () => {
  it("is reported as failed, not deployed", async () => {
    const result = await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([ok(row("exited", "id-1", 1))]) });
    expect(result.failed).toBe(1);
    expect(result.deployed).toBe(0);
  });

  it("an exit code of 0 is a completed one-shot, not a crash", async () => {
    const result = await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([ok(row("exited", "id-1", 0))]) });
    expect(result.failed).toBe(0);
  });
});

describe("when the runtime cannot be asked, the unknown is recorded, not guessed", () => {
  it("records convergeAction as unknown rather than a verdict, and neither deployed nor failed", async () => {
    await seedRender();
    const result = await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([unknown("no socket at /var/run/docker.sock")]) });
    expect(result.apps[0]?.convergeAction).toBe("unknown");
    expect(result.apps[0]?.unknownReason).toContain("docker.sock");
    expect(result.deployed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("on a FIRST deploy, an unreadable crash check is unknown too — not deployed", async () => {
    const result = await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([unknown("api unavailable")]) });
    expect(result.apps[0]?.planStatus).toBe("new");
    expect(result.apps[0]?.convergeAction).toBe("unknown");
    expect(result.deployed).toBe(0);
    expect(result.unchanged).toBe(1);
  });
});

describe("findCrashedServices — one implementation", () => {
  it("names the services that exited non-zero", async () => {
    const out = await findCrashedServices(observerWith([ok(row("exited", "id-1", 137))]), APP);
    expect(out).toEqual({ kind: "ok", value: [`${APP} exited 137`] });
  });
  it("returns an empty list when everything is running, and for a completed one-shot", async () => {
    expect(await findCrashedServices(observerWith([ok(row("running"))]), APP)).toEqual({ kind: "ok", value: [] });
    expect(await findCrashedServices(observerWith([ok(row("exited", "id-1", 0))]), APP)).toEqual({ kind: "ok", value: [] });
  });
  it("returns unknown, with the reason, when the runtime could not be asked", async () => {
    const out = await findCrashedServices(observerWith([unknown("Cannot connect to the Docker daemon")]), APP);
    expect(out).toEqual({ kind: "unknown", reason: "Cannot connect to the Docker daemon" });
  });
});

describe("🚨 a crash a moment after start, and a restart loop, are both crashes", () => {
  it("reads again after the grace period and catches a service that died in between", async () => {
    // t=0: running; after the grace: exited 1. One read at t=0 used to call this deployed.
    const result = await deploy({
      appbayHome: home, dockerCompose: compose, crashGraceMs: 1, sleep: async () => {},
      observer: observerWith([ok(row("running")), ok(row("exited", "id-1", 1))]),
    });
    expect(result.failed).toBe(1);
    expect(result.apps[0]?.error).toContain("exited 1");
  });

  it("counts a restart-looping service as crashed, not running", async () => {
    const result = await deploy({ appbayHome: home, dockerCompose: compose, crashGraceMs: 0, observer: observerWith([ok(row("restarting"))]) });
    expect(result.failed).toBe(1);
    expect(result.apps[0]?.error).toContain("restart-looping");
  });

  it("does not wait the grace when the first read already shows a crash", async () => {
    let slept = 0;
    const result = await deploy({
      appbayHome: home, dockerCompose: compose, crashGraceMs: 5000, sleep: async () => { slept++; },
      observer: observerWith([ok(row("exited", "id-1", 2))]),
    });
    expect(result.failed).toBe(1);
    expect(slept).toBe(0);
  });
});
