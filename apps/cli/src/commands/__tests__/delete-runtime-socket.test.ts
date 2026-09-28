import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

let home: string;
let socket: string;
let server: Server;
let rows: unknown[] = [];
const appDir = () => join(home, "etc", "apps", "whoami");
const compose = "services:\n  whoami:\n    image: traefik/whoami\n";

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "appbay-delete-socket-"));
  socket = join(home, "engine.sock");
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.startsWith("/containers/") && req.url.endsWith("/json")) {
      res.end(JSON.stringify({ Id: "id", Name: "/whoami-1", Image: "image", State: { Running: false, Status: "exited", ExitCode: 0 } }));
    } else res.end(JSON.stringify(rows));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});

beforeEach(() => {
  rows = [];
  rmSync(join(home, "etc"), { recursive: true, force: true });
  rmSync(join(home, "var"), { recursive: true, force: true });
  rmSync(join(home, "outside"), { recursive: true, force: true });
  mkdirSync(appDir(), { recursive: true });
  writeFileSync(join(appDir(), "docker-compose.yml"), compose);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

const container = (workingDir?: string) => ({
  Id: "id", Names: ["/whoami-1"], State: "exited", Status: "exited",
  Labels: {
    "com.docker.compose.project": "whoami",
    "com.docker.compose.service": "whoami",
    ...(workingDir === undefined ? {} : { "com.docker.compose.project.working_dir": workingDir }),
  },
  Ports: [],
});

function runDelete(app = "whoami"): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", "src/index.ts", "delete", app, "--force"], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: { ...process.env, APPBAY_HOME: home, APPBAY_RUNTIME_SOCKET: socket },
    });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.on("close", (code) => resolve({ code, output }));
  });
}

describe("delete --force through APPBAY_RUNTIME_SOCKET", () => {
  it.each([
    ["foreign", "/srv/other/var/lib/renders/whoami"],
    ["missing", undefined],
  ])("refuses %s ownership before a project-wide down", async (_case, workingDir) => {
    const renderDir = join(home, "var", "lib", "renders", "whoami");
    mkdirSync(renderDir, { recursive: true });
    writeFileSync(join(renderDir, "docker-compose.rendered.yml"), compose);
    rows = [container(workingDir)];
    const result = await runDelete();
    expect(result.code).toBe(1);
    expect(result.output).toContain("nothing was deleted");
    expect(existsSync(appDir())).toBe(true);
  });

  it("deletes the app when no containers exist", async () => {
    expect((await runDelete()).code).toBe(0);
    expect(existsSync(appDir())).toBe(false);
  });

  it("deletes the app when its only container is exited and owned here", async () => {
    rows = [container(join(home, "var", "lib", "renders", "whoami"))];
    expect((await runDelete()).code).toBe(0);
    expect(existsSync(appDir())).toBe(false);
  });

  it("does not require ownership when no runtime mutation is needed", async () => {
    rows = [container("/srv/other/var/lib/renders/whoami")];
    expect((await runDelete()).code).toBe(0);
    expect(existsSync(appDir())).toBe(false);
  });

  it("refuses a discovered symlink outside the apps root", async () => {
    const outside = join(home, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "docker-compose.yml"), compose);
    symlinkSync(outside, join(home, "etc", "apps", "alias"), "dir");
    const result = await runDelete("alias");
    expect(result.code).toBe(1);
    expect(existsSync(join(outside, "docker-compose.yml"))).toBe(true);
  });

  it("refuses a discovered alias to another app directory", async () => {
    const realApp = join(home, "etc", "apps", "real-app");
    mkdirSync(realApp);
    writeFileSync(join(realApp, "docker-compose.yml"), compose);
    symlinkSync(realApp, join(home, "etc", "apps", "alias"), "dir");

    const result = await runDelete("alias");

    expect(result.code).toBe(1);
    expect(existsSync(join(realApp, "docker-compose.yml"))).toBe(true);
  });
});
