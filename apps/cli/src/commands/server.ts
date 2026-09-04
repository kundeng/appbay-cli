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
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  controlPlaneEdgeFragments,
  controlPlaneHost,
  parseInstanceConfig,
  readInstanceConfigText,
} from "@appbay/core";

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

/**
 * Pure runtime-socket policy, exported so both rootful and rootless paths stay tested.
 *
 * 🚨 `uid === 0` ANSWERS "AM I ROOT", AND THE QUESTION IS "WHICH SOCKET DOES THIS INSTALL USE".
 * Those were the same question until S34, which put the D-6 service account — uid 950 — on the
 * ROOTFUL socket via `CONTAINER_HOST`. The uid test then computed
 * `/run/user/950/podman/podman.sock`, a rootless socket that does not exist, and the control
 * plane died with `statfs /run/user/950/podman/podman.sock: no such file or directory` on a
 * host where every access grant was correct. `CONTAINER_HOST` is consulted first because it is
 * the direct statement of which socket this process talks to; the uid is a proxy for it.
 */
export function runtimeSocketFor(
  runtime: string,
  uid: number,
  xdgRuntimeDir?: string,
  override?: string,
  containerHost?: string,
): string {
  if (override) return override;
  if (runtime !== "podman") return "/var/run/docker.sock";
  // Only `unix://` says anything about a local path. A tcp:// or ssh:// CONTAINER_HOST means
  // the socket is not on this host at all, and mounting a guessed local path would be worse
  // than falling through.
  if (containerHost?.startsWith("unix://")) {
    return containerHost.slice("unix://".length);
  }
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
    process.env.CONTAINER_HOST,
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

/**
 * Write the edge's route to the control plane — RFC-001 §1, task 5.1c.
 *
 * 🚨 THIS DOES NOT CLOSE THE PUBLISHED PORT, and the web UI still checks its own password.
 * It makes the edge *a* way in so the cutover has somewhere to land; making it the ONLY way
 * in is `APPBAY_BIND=127.0.0.1`, and doing that before this route existed would have locked
 * operators out. Doing the cutover before the flip would be an authentication bypass.
 *
 * Silent on every path where there is nothing to do — no caddy install, no hostname — because
 * a local installation legitimately has neither and a warning on every `server start` trains
 * operators to ignore warnings.
 */
function writeControlPlaneEdgeRoute(appbayHome: string): string | null {
  const caddyDir = join(appbayHome, "etc", "apps", "caddy");
  if (!existsSync(caddyDir)) return null; // Traefik installs and pre-edge installs have no target.

  const raw = readInstanceConfigText(appbayHome, (p) => readFileSync(p, "utf-8")) ?? "";
  const cfg = parseInstanceConfig(raw);
  if (cfg.ingress_provider === "traefik") return null; // The auth portal is Caddy Security only.

  const host = controlPlaneHost(cfg.domain, cfg.server_host);
  if (!host) return null; // No domain and no explicit host — nothing to serve it at.

  for (const fragment of controlPlaneEdgeFragments(host)) {
    const target = join(appbayHome, fragment.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, fragment.content, "utf-8");
  }
  return host;
}

/**
 * Decide which interface the control plane's port binds to — RFC-001 §1, task 5.1c part three.
 *
 * 🚨 LOOPBACK ONLY WHEN THERE IS SOMEWHERE ELSE TO GO IN. Binding to 127.0.0.1 with no edge
 * route is a lockout, not a hardening: the operator loses the UI and gains nothing. So the
 * default follows the route — if `writeControlPlaneEdgeRoute` produced a host, the edge is a
 * way in and the direct port stops being one; if it did not, nothing changes.
 *
 * ⚠️ THIS IS DECIDED PER START, NOT BAKED INTO THE COMPOSE FILE. `appbay init` writes
 * docker-compose.server.yml only when it is ABSENT, so a value chosen at init time would
 * never reach an existing installation — and this is exactly the setting existing
 * installations need before RFC-001 §1 can hand authentication to the edge.
 *
 * An explicit `APPBAY_BIND` in the environment always wins. That is the escape hatch for an
 * operator whose edge is configured but not yet actually working.
 */
function resolveServerBind(edgeHost: string | null): string {
  const explicit = process.env.APPBAY_BIND?.trim();
  if (explicit) return explicit;
  return edgeHost ? "127.0.0.1" : "0.0.0.0";
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

    // 3b. Give the edge a route to the control plane (RFC-001 §1, task 5.1c).
    const edgeHost = writeControlPlaneEdgeRoute(resolveAppbayHome());
    const bind = resolveServerBind(edgeHost);
    if (edgeHost) {
      console.log(`  Edge route: https://${edgeHost} -> the control plane (admins only)`);
    }
    if (bind === "127.0.0.1") {
      console.log(
        "  Port 3000 is bound to loopback — the edge is the way in. " +
          "Override with APPBAY_BIND=0.0.0.0.",
      );
    }

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
      APPBAY_BIND: bind,
      // 🚨 EDGE AUTH AND THE LOOPBACK BIND ARE ONE DECISION. The web UI trusts the edge's
      // Remote-User header only when this is "1", and it is "1" only when the port is closed
      // to the network. Setting one without the other is the bypass: with 3000 reachable,
      // anyone who can reach it sets their own identity. Tying them here means neither can
      // be enabled alone by accident.
      APPBAY_EDGE_AUTH: bind === "127.0.0.1" ? "1" : "",
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
