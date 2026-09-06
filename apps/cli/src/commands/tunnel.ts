import { Command } from "commander";
import { runningContainerNames, SHARED_NETWORK, containerExec, containerSpawn } from "@appbay/core";
import { resolveAppbayHome, resolveAppsDir } from "../utils/appbay-home.js";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

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
    const appbayHome = resolveAppbayHome();
    const cfCheck = containerExec(["image", "ls", "-q", "cloudflare/cloudflared"], { appbayHome, timeout: 10_000 });
    const hasImage = cfCheck.exitCode === 0 && cfCheck.output.trim().length > 0;

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
    containerExec(["rm", "-f", containerName], { appbayHome, timeout: 10_000 });

    console.log(`Creating tunnel for ${app} → ${targetUrl}`);
    console.log("Waiting for Cloudflare URL...\n");

    if (!hasImage) {
      console.log("Pulling cloudflared image...");
      containerExec(["pull", "cloudflare/cloudflared:latest"], { appbayHome, stdio: "inherit", timeout: 120_000 });
    }

    // Start tunnel in background
    const child = containerSpawn(
      [
        "run", "--rm",
        "--name", containerName,
        "--network", SHARED_NETWORK,
        "cloudflare/cloudflared:latest",
        "tunnel", "--url", targetUrl,
      ],
      { appbayHome, stdio: ["ignore", "pipe", "pipe"] },
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
      containerExec(["rm", "-f", containerName], { appbayHome, timeout: 5_000 });
      process.exit(0);
    });
  });

export const tunnelDownCommand = new Command("tunnel-down")
  .description("Stop all running Cloudflare tunnels")
  .action(async () => {
    const appbayHome = resolveAppbayHome();
    const named = await runningContainerNames("appbay.tunnel.", appbayHome);
    if (named.kind === "unknown") {
      console.error(`Could not list tunnels: ${named.reason}`);
      process.exit(1);
    }
    const tunnels = named.value;

    if (tunnels.length === 0) {
      console.log("No running tunnels.");
      return;
    }

    for (const name of tunnels) {
      containerExec(["rm", "-f", name], { appbayHome, timeout: 10_000 });
      const app = name.replace("appbay.tunnel.", "");
      console.log(`Stopped tunnel: ${app}`);
    }
  });
