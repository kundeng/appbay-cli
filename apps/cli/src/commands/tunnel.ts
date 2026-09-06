import { Command } from "commander";
import { runningContainerNames, SHARED_NETWORK, containerExec, containerSpawn } from "@appbay/core";
import { resolveAppbayHome, resolveAppsDir } from "../utils/appbay-home.js";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * The URL cloudflared, running on the shared network, reaches the app at: the first service
 * the render puts on that network, by its alias there (unique per app), on the port its
 * ingress trait names or, failing that, the container port of its first published mapping.
 */
function upstreamUrl(app: string): string | null {
  const home = resolveAppbayHome();
  const renderPath = join(home, "var", "lib", "renders", app, "docker-compose.rendered.yml");
  if (!existsSync(renderPath)) return null;
  const ingressPort = (() => {
    try {
      const config = parseYaml(readFileSync(join(resolveAppsDir(), app, "appbay.yaml"), "utf-8")) as { traits?: Array<{ type?: string; port?: number }>; services?: Record<string, { traits?: Array<{ type?: string; port?: number }> }> };
      const all = [...(config.traits ?? []), ...Object.values(config.services ?? {}).flatMap((svc) => svc.traits ?? [])];
      return all.find((t) => t.type === "ingress" && t.port)?.port;
    } catch { return undefined; }
  })();
  try {
    const compose = parseYaml(readFileSync(renderPath, "utf-8")) as { services?: Record<string, { ports?: unknown[]; networks?: Record<string, { aliases?: string[] } | null> }> };
    for (const config of Object.values(compose.services ?? {})) {
      const alias = config.networks?.[SHARED_NETWORK]?.aliases?.[0];
      if (!alias) continue;
      const first = config.ports?.[0];
      const containerPort = typeof first === "string" ? first.split("/")[0]?.split(":").pop() : typeof first === "object" && first ? String((first as { target?: number }).target ?? "") : "";
      const port = ingressPort ?? (containerPort ? Number(containerPort) : undefined);
      if (port) return `http://${alias}:${String(port)}`;
      return `http://${alias}`;
    }
  } catch { /* an unreadable render is "cannot determine" below */ }
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
      const url = upstreamUrl(app);
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
      const pulled = containerExec(["pull", "cloudflare/cloudflared:latest"], { appbayHome, stdio: "inherit", timeout: 120_000 });
      if (pulled.exitCode !== 0) {
        console.error(`Could not pull cloudflared${pulled.failedToStart || pulled.timedOut ? `: ${pulled.output.trim()}` : ""}.`);
        process.exit(1);
      }
    }

    // Start tunnel in background
    const child = containerSpawn(
      [
        "run", "--rm",
        "--name", containerName,
        "--network", SHARED_NETWORK,
        // Linux Docker resolves host.docker.internal only when told to; Podman and Docker
        // Desktop already do, and accept the flag.
        "--add-host", "host.docker.internal:host-gateway",
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

    child.on("error", (err) => {
      clearTimeout(timeout);
      console.error(`Could not start the tunnel container: ${err.message}`);
      process.exit(1);
    });

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
