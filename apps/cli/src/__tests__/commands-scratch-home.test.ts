/**
 * The command actions, driven end to end against a scratch home. The command tests used to
 * cover only their pure helpers; nothing ran `doctor`, `status`, `list` or `ps` as a user
 * does (review 2026-09-05, Seam 5). These spawn the CLI source under bun with APPBAY_HOME
 * pointing at a temp directory, so they need no runtime for the read-only commands and
 * skip the runtime-touching ones when no container binary answers.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(__dirname, "..", "index.ts");
let home: string;

function appbay(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bun", ["run", CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, APPBAY_HOME: home, APPBAY_CONTAINER_RUNTIME: "docker" },
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const hasRuntime = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "appbay-cmd-"));
  const init = appbay(["init", "--dir", home, "--yes", "--project", "t", "--domain", "appbay.local"]);
  expect(init.status, init.stderr).toBe(0);
});
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe("commands against a scratch home", () => {
  it("init wrote the system config and seeded the default edge", () => {
    expect(existsSync(join(home, "etc", "system.yaml"))).toBe(true);
    expect(existsSync(join(home, "etc", "apps", "traefik", "docker-compose.yml"))).toBe(true);
    expect(existsSync(join(home, "etc", "namespaces", "default.yaml"))).toBe(true);
  });

  it("list shows every seeded app with its namespace", () => {
    const r = appbay(["list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/whoami\s+default/);
    expect(r.stdout).toMatch(/traefik\s+system/);
  });

  it("status names the app's directory and services", () => {
    const r = appbay(["status", "whoami"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Namespace:   default");
    expect(r.stdout).toContain("- whoami");
  });

  it("doctor --json is a three-valued report and never ok over a required unknown", () => {
    const r = appbay(["doctor", "--json"]);
    const payload = JSON.parse(r.stdout) as { ok: boolean; checks: Array<{ name: string; status: string; passed: boolean; required: boolean }> };
    expect(typeof payload.ok).toBe("boolean");
    for (const c of payload.checks) {
      expect(["ok", "failed", "unknown"]).toContain(c.status);
      expect(c.passed).toBe(c.status === "ok");
    }
    const requiredNotOk = payload.checks.some((c) => c.required && c.status !== "ok");
    expect(payload.ok).toBe(!requiredNotOk);
  });

  it("compile renders whoami and its traefik fragment", () => {
    const r = appbay(["compile", "whoami"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(home, "var", "lib", "renders", "whoami", "docker-compose.rendered.yml"))).toBe(true);
  });

  it("compile --namespace resolves ${{ns:KEY}} from that namespace's values file", () => {
    writeFileSync(join(home, "etc", "namespaces", "lab.yaml"), "DOMAIN: lab.example.org\nTIER: lab\n");
    mkdirSync(join(home, "etc", "apps", "echo"), { recursive: true });
    writeFileSync(join(home, "etc", "apps", "echo", "docker-compose.yml"),
      "services:\n  echo:\n    image: traefik/whoami\n    environment:\n      - TIER=${{ns:TIER}}\n");
    writeFileSync(join(home, "etc", "apps", "echo", "appbay.yaml"), "traits:\n  - type: ingress\n    port: 80\n    service: echo\n");
    const r = appbay(["compile", "echo", "--namespace", "lab"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const rendered = readFileSync(join(home, "var", "lib", "renders", "echo", "docker-compose.rendered.yml"), "utf-8");
    expect(rendered).toContain("TIER=lab");
    const fragment = readFileSync(join(home, "var", "lib", "renders", "echo", "etc", "apps", "traefik", "config", "dynamic", "lab.echo.yml"), "utf-8");
    expect(fragment).toContain("Host(`lab.echo.lab.example.org`)");
    // The alias the fragment dials is the alias the compose file declares.
    expect(fragment).toContain("http://lab_echo_echo:80");
    expect(rendered).toContain("- lab_echo_echo");
    expect(rendered).toContain("container_name: appbay.lab.echo.echo");
    const plain = appbay(["compile", "echo"]);
    expect(plain.status).not.toBe(0);
    expect(plain.stdout + plain.stderr).toContain('"TIER" in scope "ns"');
  });

  it.skipIf(!hasRuntime)("ps lists nothing for an app that was never started, without failing", () => {
    const r = appbay(["ps", "whoami"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/0 container\(s\)|No/);
  });
});
