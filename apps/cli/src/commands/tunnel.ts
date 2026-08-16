import { Command } from "commander";
import { spawnSync, spawn } from "node:child_process";
import { resolveAppbayHome, resolveAppsDir } from "../utils/appbay-home.js";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { cliContainerBin } from "../utils/docker.js";

function getAppUrl(app: string): string | null {
  const appsDir = resolveAppsDir();
  const appbayYaml = join(appsDir, app, "appbay.yaml");
  if (!existsSync(appbayYaml)) return null;

  try {
    const config = parseYaml(readFileSync(appbayYaml, "utf-8"));
    const traits = config?.traits ?? [];
    for (const t of traits) {
      if (t.type === "ingress" && t.host && t.port) {
        return `http://localhost:${t.port}`;
      }
    }
  } catch { /* ignore parse errors */ }

  return null;
}

function getInternalUrl(app: string): string | null {
  const home = resolveAppbayHome();
  const renderPath = join(home, "var", "lib", "renders", app, "docker-compose.rendered.yml");
  if (!existsSync(renderPath)) return null;

  try {
    const compose = parseYaml(readFileSync(renderPath, "utf-8"));
    const services = compose?.services ?? {};
    for (const [svc, config] of Object.entries(services) as Array<[string, Record<string, unknown>]>) {
      const ports = config.ports as string[] | undefined;
      if (ports && ports.length > 0) {
        const first = String(ports[0]);
        const match = first.match(/:(\d+)/);
        if (match) return `http://${svc}:${match[1]}`;
      }
    }
  } catch { /* ignore */ }

  return null;
}

export const tunnelCommand = new Command("tunnel")
  .description("Create a Cloudflare quick tunnel to expose a local app publicly")
  .argument("<app>", "app name to tunnel")
  .option("--port <port>", "override the port to tunnel")
  .action((app: string, options: { port?: string }) => {
    // Check cloudflared is available
    const cfCheck = spawnSync(cliContainerBin(), ["image", "ls", "-q", "cloudflare/cloudflared"], {
      encoding: "utf-8",
      timeout: 10_000,
    });

    const hasImage = cfCheck.status === 0 && (cfCheck.stdout as string).trim().length > 0;

    let targetUrl: string;
    if (options.port) {
      targetUrl = `http://host.docker.internal:${options.port}`;
    } else {
      // Try to find the app's ingress port from its compose
      const url = getAppUrl(app) || getInternalUrl(app);
      if (!url) {
        console.error(`Cannot determine port for "${app}". Use --port to specify.`);
        process.exit(1);
      }
      targetUrl = url;
    }

    const containerName = `appbay.tunnel.${app}`;

    // Stop existing tunnel for this app
    spawnSync(cliContainerBin(), ["rm", "-f", containerName], {
      encoding: "utf-8",
      timeout: 10_000,
    });

    console.log(`Creating tunnel for ${app} → ${targetUrl}`);
    console.log("Waiting for Cloudflare URL...\n");

    if (!hasImage) {
      console.log("Pulling cloudflared image...");
      spawnSync(cliContainerBin(), ["pull", "cloudflare/cloudflared:latest"], {
        stdio: "inherit",
        timeout: 120_000,
      });
    }

    // Start tunnel in background
    const child = spawn(
      cliContainerBin(),
      [
        "run", "--rm",
        "--name", containerName,
        "--network", "appbay_shared",
        "cloudflare/cloudflared:latest",
        "tunnel", "--url", targetUrl,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let found = false;
    const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

    const onData = (data: Buffer) => {
      const text = data.toString();
      const match = text.match(urlRegex);
      if (match && !found) {
        found = true;
        console.log(`Tunnel URL: ${match[0]}`);
        console.log(`\nPress Ctrl+C to stop the tunnel.`);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    // Timeout after 30 seconds
    const timeout = setTimeout(() => {
      if (!found) {
        console.error("Timed out waiting for tunnel URL.");
        child.kill();
        process.exit(1);
      }
    }, 30_000);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (!found) {
        console.error("Tunnel exited before establishing connection.");
      }
      process.exit(code ?? 1);
    });

    process.on("SIGINT", () => {
      console.log("\nStopping tunnel...");
      child.kill();
      spawnSync(cliContainerBin(), ["rm", "-f", containerName], { timeout: 5_000 });
      process.exit(0);
    });
  });

export const tunnelDownCommand = new Command("tunnel-down")
  .description("Stop all running Cloudflare tunnels")
  .action(() => {
    const ps = spawnSync(
      cliContainerBin(),
      ["ps", "--format", "{{.Names}}", "--filter", "name=appbay.tunnel."],
      { encoding: "utf-8", timeout: 10_000 },
    );

    const tunnels = (ps.stdout as string).trim().split("\n").filter(Boolean);

    if (tunnels.length === 0) {
      console.log("No running tunnels.");
      return;
    }

    for (const name of tunnels) {
      spawnSync(cliContainerBin(), ["rm", "-f", name], { timeout: 10_000 });
      const app = name.replace("appbay.tunnel.", "");
      console.log(`Stopped tunnel: ${app}`);
    }
  });
