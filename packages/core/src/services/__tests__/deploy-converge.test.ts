/**
 * What `deploy()` counts as deployed, unchanged, or failed — appbay-cli#4 and #5.
 *
 * ⭐ ONE INVARIANT RUNS THROUGH ALL OF THIS: an answer compose could not give is UNKNOWN, and
 * an unknown must never be reported as a verdict. The module says so at four separate points
 * ("do not invent a failure", "the caller must treat null as unknown, never as nothing
 * running"), and every bug it cites is that rule being broken:
 *
 *   - `compose up -d` exits 0 when it STARTS a container; it does not wait to see it stay up,
 *     so a service that dies immediately reported "1 deployed, 0 error(s)".
 *   - podman-compose pretty-prints an array behind a banner while docker emits NDJSON, so
 *     line-by-line parsing returned an EMPTY list — which reads as "no containers", a verdict,
 *     rather than as a parse failure.
 *   - `[UNCHANGED]` is a verdict about the compiled ARTIFACT and was summed as though it were
 *     one about the DEPLOYMENT. With the container deleted and the render byte-identical,
 *     `appbay up whoami` created it and reported `0 deployed, 1 unchanged`.
 *
 * The runner is injected, so this drives the real `deploy()` rather than exported internals.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { deploy, type DockerComposeRunner } from "../deploy-service.js";

let home: string;

const APP = "whoami";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "appbay-converge-"));
  const appDir = join(home, "etc", "apps", APP);
  await mkdir(appDir, { recursive: true });
  await writeFile(
    join(appDir, "docker-compose.yml"),
    `services:\n  ${APP}:\n    image: traefik/whoami\n`,
  );
});

const CONTAINER = `appbay.${APP}.${APP}`;

/** A `compose ps` row as docker emits it (NDJSON). */
function row(state: string, id = "id-1", exitCode = 0) {
  return JSON.stringify({ ID: id, Name: CONTAINER, Service: APP, State: state, ExitCode: exitCode });
}

/**
 * A fake runner answering `ps` from a queue — one entry per call — and succeeding otherwise.
 *
 * ⚠️ THE SEQUENCE IS THREE `ps` CALLS, not two, and only on a SECOND deploy. Observed rather
 * than assumed:
 *
 *   first deploy   ["up -d", "ps"]                      plan is `new`; no before-snapshot
 *   later deploys  ["ps", "up -d", "ps", "ps"]          before, after, crashed-services
 *
 * The convergence question only arises when the plan says the artifact is UNCHANGED, which is
 * exactly the appbay-cli#4 scenario: render identical, container gone.
 */
function runnerWith(psResponses: Array<{ exitCode: number; output: string }>): DockerComposeRunner {
  let i = 0;
  return (subArgs) => {
    if (subArgs[0] === "ps") {
      const r = psResponses[Math.min(i++, psResponses.length - 1)] ?? { exitCode: 1, output: "" };
      return { exitCode: r.exitCode, output: r.output };
    }
    return { exitCode: 0, output: "" };
  };
}

const ok = (output: string) => ({ exitCode: 0, output });

/** Deploy once so the render exists and later plans report `unchanged`. */
async function seedRender(): Promise<void> {
  await deploy({
    appbayHome: home,
    dockerCompose: runnerWith([ok(row("running", "seed-id"))]),
  });
}

describe("🚨 an UNCHANGED artifact does not mean an unchanged deployment", () => {
  it("a container that was gone and is now created counts as DEPLOYED", async () => {
    // appbay-cli#4, exactly. The render is byte-identical to last time and the container is
    // gone; those are answers to different questions, and `[UNCHANGED]` answers the wrong one.
    await seedRender();
    const result = await deploy({
      appbayHome: home,
      dockerCompose: runnerWith([ok(""), ok(row("running", "new-id")), ok(row("running", "new-id"))]),
    });
    expect(result.apps[0]?.planStatus).toBe("unchanged");
    expect(result.deployed).toBe(1);
    expect(result.unchanged).toBe(0);
  });

  it("already running, same id, is the one genuinely unchanged case", async () => {
    await seedRender();
    const running = ok(row("running", "same-id"));
    const result = await deploy({
      appbayHome: home,
      dockerCompose: runnerWith([running, running, running]),
    });
    expect(result.unchanged).toBe(1);
    expect(result.deployed).toBe(0);
  });

  it("a RECREATED container — same name, new id — is deployed", async () => {
    await seedRender();
    const result = await deploy({
      appbayHome: home,
      dockerCompose: runnerWith([
        ok(row("running", "old-id")),
        ok(row("running", "new-id")),
        ok(row("running", "new-id")),
      ]),
    });
    expect(result.deployed).toBe(1);
    expect(result.unchanged).toBe(0);
  });
});

describe("🚨 a service that starts and immediately dies is NOT a success", () => {
  it("is reported as failed, not deployed", async () => {
    // `compose up -d` exits 0 for this. Only the ps afterwards can tell.
    const crashed = ok(row("exited", "id-1", 1));
    const result = await deploy({
      appbayHome: home,
      dockerCompose: runnerWith([crashed]),
    });
    expect(result.failed).toBe(1);
    expect(result.deployed).toBe(0);
  });

  it("an exit code of 0 is a completed one-shot, not a crash", async () => {
    const result = await deploy({
      appbayHome: home,
      dockerCompose: runnerWith([ok(row("exited", "id-1", 0))]),
    });
    expect(result.failed).toBe(0);
  });
});

describe("🚨 podman-compose's pretty-printed array parses too", () => {
  it("a banner and a multi-line array are not an empty container list", async () => {
    // Parsing this line-by-line yields nothing valid, and an empty list reads as
    // "no containers" — a verdict rather than the absence of one. It passed 10/10 on Docker
    // before failing on the second runtime.
    await seedRender();
    const podman = ok(
      `>>>> Executing external compose provider "/usr/sbin/podman-compose" <<<<\n` +
        `[\n  {\n    "Names": [ "${CONTAINER}" ],\n    "State": "running",\n    "ID": "abc"\n  }\n]\n`,
    );
    const result = await deploy({
      appbayHome: home,
      dockerCompose: runnerWith([ok(""), podman, podman]),
    });
    // Seen as created -> deployed. If the parse returned nothing, the after-snapshot would be
    // empty and this would report `unchanged` instead.
    expect(result.deployed).toBe(1);
    expect(result.unchanged).toBe(0);
  });
});

describe("when compose cannot be asked, the unknown is recorded, not guessed", () => {
  /**
   * ⚠️ I first asserted that an unknown must not be counted as `unchanged` either, and the
   * code disagreed — with a reason worth keeping:
   *
   *     "unknown" is counted as unchanged rather than deployed: compose could not be asked,
   *     and inventing a deployment is the same error in the other direction.
   *
   * The summary has four buckets and none of them means "do not know", so one must be chosen.
   * What matters is that the uncertainty survives on the app record rather than being erased,
   * and that the safer of the two is picked. Both are pinned below.
   */
  it("records convergeAction as unknown rather than a verdict", async () => {
    await seedRender();
    const result = await deploy({
      appbayHome: home,
      dockerCompose: runnerWith([{ exitCode: 1, output: "" }]),
    });
    expect(result.apps[0]?.convergeAction).toBe("unknown");
  });

  it("does not invent a deployment", async () => {
    // The direction that matters: claiming a deploy happened when nothing is known would
    // report success for a converge that may never have touched anything.
    await seedRender();
    const result = await deploy({
      appbayHome: home,
      dockerCompose: runnerWith([{ exitCode: 1, output: "" }]),
    });
    expect(result.deployed).toBe(0);
  });

  it("does not manufacture a failure either", async () => {
    await seedRender();
    const result = await deploy({
      appbayHome: home,
      dockerCompose: runnerWith([{ exitCode: 1, output: "" }]),
    });
    expect(result.failed).toBe(0);
  });
});
