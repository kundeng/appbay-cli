/**
 * The entrypoint-wrapper mode's compose rewrite: the injector is bind-mounted from the
 * install's bin/ with an SELinux relabel, and the entrypoint runs it ahead of the command.
 * On an enforcing host the unlabelled mount was unreadable and the container exited 139
 * before anything ran (issue #9, Podman 5.8 on Fedora 44).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../../compiler/compile.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "appbay-ew-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("secrets trait, entrypoint-wrapper", () => {
  it("mounts the injector read-only with an SELinux relabel and wraps the entrypoint", async () => {
    const appsDir = join(dir, "etc", "apps");
    await mkdir(join(appsDir, "ew"), { recursive: true });
    await writeFile(join(appsDir, "ew", "docker-compose.yml"), "services:\n  app:\n    image: alpine\n    command: [\"sleep\", \"1\"]\n");
    await writeFile(join(appsDir, "ew", "appbay.yaml"),
      "upstream:\n  source: ./docker-compose.yml\nservices:\n  app:\n    traits:\n      - type: secrets\n        injection: entrypoint-wrapper\n        refs:\n          PW: vault://ew/PW\n");
    const r = await compile({ appsDir, rendersDir: join(dir, "renders"), stateDir: join(dir, "state"), projectVars: { DOMAIN: "x.test" } });
    expect(r.errors).toEqual([]);
    const rendered = r.apps[0]!.rendered;
    expect(rendered).toContain(`${join(dir, "bin", "appbay-inject")}:/appbay-inject:ro,z`);
    expect(rendered).toContain("appbay-secrets-ew:/run/secrets/ew:ro");
    expect(rendered).toMatch(/entrypoint:\n\s+- \/appbay-inject\n\s+- --app\n\s+- ew\n\s+- --service\n\s+- app\n\s+- --\n\s+- sleep\n\s+- "?1"?/);
  });
});
