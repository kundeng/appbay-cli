import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopApps } from "../down.js";

let home: string;
let socket: string;
let server: Server;
let rows: unknown[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "appbay-down-socket-"));
  const app = join(home, "etc", "apps", "whoami");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "docker-compose.yml"), "services:\n  whoami:\n    image: traefik/whoami\n");
  socket = join(home, "engine.sock");
  process.env.APPBAY_RUNTIME_SOCKET = socket;
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.startsWith("/containers/") && req.url.endsWith("/json")) {
      res.end(JSON.stringify({ Id: "id", Name: "/whoami-1", Image: "image", State: { Running: false, Status: "exited", ExitCode: 0 } }));
    } else {
      res.end(JSON.stringify(rows));
    }
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});

afterAll(async () => {
  delete process.env.APPBAY_RUNTIME_SOCKET;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

const container = (state: string, workingDir: string) => ({
  Id: "id", Names: ["/whoami-1"], State: state, Status: state,
  Labels: {
    "com.docker.compose.project": "whoami",
    "com.docker.compose.service": "whoami",
    "com.docker.compose.project.working_dir": workingDir,
  },
  Ports: [],
});

describe("render-less down through APPBAY_RUNTIME_SOCKET", () => {
  it("does not call an exited container running or refuse it", async () => {
    rows = [container("exited", join(home, "var", "lib", "renders", "whoami"))];
    expect(await stopApps(home, ["whoami"])).toMatchObject({ stopped: 0, failed: 0 });
  });

  it("does not require ownership when no render or running container makes Compose necessary", async () => {
    rows = [container("exited", "/srv/other/var/lib/renders/whoami")];
    expect(await stopApps(home, ["whoami"])).toMatchObject({ stopped: 0, failed: 0 });
  });

  it("refuses a running project owned by another home", async () => {
    rows = [container("running", "/srv/other/var/lib/renders/whoami")];
    expect(await stopApps(home, ["whoami"])).toMatchObject({ stopped: 0, failed: 1 });
  });

  it("checks exited rows too when running and exited ownership is mixed", async () => {
    rows = [
      container("running", join(home, "var", "lib", "renders", "whoami")),
      { ...container("exited", "/srv/other/var/lib/renders/whoami"), Id: "other" },
    ];
    expect(await stopApps(home, ["whoami"])).toMatchObject({ stopped: 0, failed: 1 });
  });

  it("fails closed when an existing container has no ownership label", async () => {
    rows = [container("running", "")];
    expect(await stopApps(home, ["whoami"])).toMatchObject({ stopped: 0, failed: 1 });
  });

  it("checks ownership even when the rendered compose file exists", async () => {
    const render = join(home, "var", "lib", "renders", "whoami", "docker-compose.rendered.yml");
    mkdirSync(join(home, "var", "lib", "renders", "whoami"), { recursive: true });
    writeFileSync(render, "services: {}\n");
    rows = [container("running", "/srv/other/var/lib/renders/whoami")];
    expect(await stopApps(home, ["whoami"])).toMatchObject({ stopped: 0, failed: 1 });
    rmSync(render);
  });
});
