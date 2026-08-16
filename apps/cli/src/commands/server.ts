/**
 * `appbay server start|stop|status` command.
 *
 * Manages the Appbay server (control plane) lifecycle. The server runs as a
 * Docker Compose stack defined in `docker-compose.server.yml` located in
 * `$APPBAY_HOME`.
 *
 * Subcommands:
 *   start   -- bring up the server container and wait for health check
 *   stop    -- bring down the server container
 *   status  -- check if the appbay.server container is running
 *
 * Exit codes:
 *   0 -- command completed successfully
 *   1 -- command failed
 */

import { Command } from "commander";
import { stat } from "node:fs/promises";
import { resolveAppbayHome, resolveServerCompose } from "../utils/appbay-home.js";
import { dockerCompose } from "../utils/docker.js";
import { tryExec } from "../utils/exec.js";
import { cliContainerBin } from "../utils/docker.js";

/** Container name used by the server compose stack. */
const SERVER_CONTAINER = "appbay.server";

/** Docker network shared across all appbay apps. */
const SHARED_NETWORK = "appbay_shared";

/** URL the server listens on. */
const SERVER_URL = "http://localhost:3000";

/** Health check endpoint. */
const HEALTH_ENDPOINT = `${SERVER_URL}/api/trpc/health.get`;

/** Maximum number of health check retries. */
const HEALTH_MAX_RETRIES = 30;

/** Delay between health check retries in milliseconds. */
const HEALTH_RETRY_DELAY_MS = 1000;

/** Pure runtime-socket policy, exported so both rootful and rootless paths stay tested. */
export function runtimeSocketFor(
  runtime: string,
  uid: number,
  xdgRuntimeDir?: string,
  override?: string,
): string {
  if (override) return override;
  if (runtime !== "podman") return "/var/run/docker.sock";
  return uid === 0
    ? "/run/podman/podman.sock"
    : `${xdgRuntimeDir ?? `/run/user/${uid}`}/podman/podman.sock`;
}

/** Resolve the host socket mounted for the server image's Docker-compatible client. */
export function resolveRuntimeSocket(): string {
  return runtimeSocketFor(
    cliContainerBin(),
    process.getuid?.() ?? 0,
    process.env.XDG_RUNTIME_DIR,
    process.env.APPBAY_RUNTIME_SOCKET,
  );
}

/**
 * Check whether the server container is currently running.
 */
function isServerRunning(): boolean {
  const state = tryExec(cliContainerBin(), [
    "inspect", "--format", "{{.State.Running}}", SERVER_CONTAINER,
  ]);
  return state === "true";
}

/**
 * Get basic info about the running server container.
 */
function getServerInfo(): {
  running: boolean;
  uptime?: string;
  image?: string;
} {
  if (!isServerRunning()) {
    return { running: false };
  }

  const uptime = tryExec(cliContainerBin(), [
    "inspect", "--format", "{{.State.StartedAt}}", SERVER_CONTAINER,
  ]);

  const image = tryExec(cliContainerBin(), [
    "inspect", "--format", "{{.Config.Image}}", SERVER_CONTAINER,
  ]);

  return {
    running: true,
    uptime: uptime ?? undefined,
    image: image ?? undefined,
  };
}

/**
 * Ensure the appbay_shared Docker network exists. Creates it if missing.
 */
function ensureNetwork(): void {
  const exists = tryExec(cliContainerBin(), ["network", "inspect", SHARED_NETWORK]);
  if (exists === null) {
    tryExec(cliContainerBin(), ["network", "create", SHARED_NETWORK]);
  }
}

/**
 * Check whether the compose file exists on disk.
 */
async function composeFileExists(composePath: string): Promise<boolean> {
  try {
    const info = await stat(composePath);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Wait for the server health endpoint to respond successfully.
 *
 * @returns true if healthy within the timeout, false otherwise.
 */
async function waitForHealth(): Promise<boolean> {
  for (let i = 0; i < HEALTH_MAX_RETRIES; i++) {
    const result = tryExec("curl", ["-sf", HEALTH_ENDPOINT]);
    if (result !== null) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_DELAY_MS));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const startCommand = new Command("start")
  .description("Start the Appbay server")
  .option("--open", "open the web UI in a browser after start")
  .action(async (options: { open?: boolean }) => {
    // 1. Check if already running.
    if (isServerRunning()) {
      console.log(`Appbay server is already running at ${SERVER_URL}`);
      process.exit(0);
    }

    // 2. Locate compose file.
    const composePath = resolveServerCompose();
    if (!(await composeFileExists(composePath))) {
      console.error(`Server compose file not found: ${composePath}`);
      console.error('Run "appbay init" first to set up the Appbay home directory.');
      process.exit(1);
    }

    // 3. Ensure shared network exists.
    ensureNetwork();

    // 4. Start the compose stack.
    console.log("Starting Appbay server...");
    const result = dockerCompose(["up", "-d"], composePath, {
      // The generated bind volume must mount the same home the invoking CLI
      // resolved; Compose otherwise falls back to the container user's ~/.appbay.
      APPBAY_HOME_PATH: resolveAppbayHome(),
      APPBAY_UID: String(process.getuid?.() ?? 1000),
      APPBAY_GID: String(process.getgid?.() ?? 1000),
      APPBAY_RUNTIME_SOCKET: resolveRuntimeSocket(),
      APPBAY_SERVER_CONTAINER_RUNTIME: "docker",
    });

    if (result.exitCode !== 0) {
      console.error(`Failed to start server (exit ${result.exitCode}):`);
      console.error(`  ${result.output}`);
      process.exit(1);
    }

    // 5. Wait for health check.
    console.log("Waiting for server to become healthy...");
    const healthy = await waitForHealth();

    if (healthy) {
      console.log(`\nAppbay server running at ${SERVER_URL}`);
      if (options.open) {
        const opener =
          process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        tryExec(opener, [SERVER_URL]);
      }
    } else {
      console.log(`\nServer started but health check did not pass within ${HEALTH_MAX_RETRIES}s.`);
      console.log(`Check logs: docker compose -f "${composePath}" logs`);
      process.exit(1);
    }
  });

const stopCommand = new Command("stop")
  .description("Stop the Appbay server")
  .action(async () => {
    const composePath = resolveServerCompose();

    if (!(await composeFileExists(composePath))) {
      console.error(`Server compose file not found: ${composePath}`);
      console.error("Nothing to stop.");
      process.exit(1);
    }

    console.log("Stopping Appbay server...");
    const result = dockerCompose(["down"], composePath, {
      APPBAY_HOME_PATH: resolveAppbayHome(),
      APPBAY_UID: String(process.getuid?.() ?? 1000),
      APPBAY_GID: String(process.getgid?.() ?? 1000),
      APPBAY_RUNTIME_SOCKET: resolveRuntimeSocket(),
      APPBAY_SERVER_CONTAINER_RUNTIME: "docker",
    });

    if (result.exitCode !== 0) {
      console.error(`Failed to stop server (exit ${result.exitCode}):`);
      console.error(`  ${result.output}`);
      process.exit(1);
    }

    console.log("Appbay server stopped.");
  });

const statusCommand = new Command("status")
  .description("Check Appbay server status")
  .action(() => {
    const info = getServerInfo();

    if (info.running) {
      console.log(`Appbay server is running at ${SERVER_URL}`);
      if (info.uptime) {
        console.log(`  Started: ${info.uptime}`);
      }
      if (info.image) {
        console.log(`  Image:   ${info.image}`);
      }
    } else {
      console.log("Appbay server is not running.");
      console.log('Run "appbay server start" to start it.');
    }
  });

// ---------------------------------------------------------------------------
// Parent command
// ---------------------------------------------------------------------------

export const serverCommand = new Command("server")
  .description("Manage the Appbay server (control plane)")
  .addCommand(startCommand)
  .addCommand(stopCommand)
  .addCommand(statusCommand);
