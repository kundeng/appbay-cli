/**
 * Two active overlays on one service keep both fragments: arrays append, label maps merge.
 * A shallow spread in compile() used to keep only the last overlay's environment
 * (review 2026-09-06, F3), while the guide promised a deep merge.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../compile.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "appbay-ovmerge-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("two overlays on one service", () => {
  it("keep both environments and both labels", async () => {
    const apps = join(dir, "apps");
    await mkdir(join(apps, "a"), { recursive: true });
    await writeFile(join(apps, "a", "docker-compose.yml"), "services:\n  web:\n    image: nginx\n");
    await writeFile(join(apps, "a", "appbay.yaml"), [
      "project: default", "overlays:",
      "  - when: [b]", "    services:", "      web:", "        environment: [FROM_B=1]", "        labels: {b: '1'}",
      "  - when: [c]", "    services:", "      web:", "        environment: [FROM_C=1]", "        labels: {c: '1'}", "",
    ].join("\n"));
    for (const peer of ["b", "c"]) {
      await mkdir(join(apps, peer), { recursive: true });
      await writeFile(join(apps, peer, "docker-compose.yml"), "services:\n  x:\n    image: nginx\n");
      await writeFile(join(apps, peer, "appbay.yaml"), "project: default\n");
    }
    const r = await compile({ appsDir: apps, rendersDir: join(dir, "renders"), stateDir: join(dir, "state"), projectVars: { DOMAIN: "x.test" } });
    expect(r.errors).toEqual([]);
    const rendered = r.apps.find((a) => a.appName === "a")!.rendered;
    for (const s of ["FROM_B=1", "FROM_C=1", 'b: "1"', 'c: "1"']) expect(rendered).toContain(s);
  });
});
