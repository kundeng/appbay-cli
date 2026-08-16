/**
 * `appbay ps [apps...]` command.
 *
 * Shows container runtime status by running `docker compose ps` against
 * rendered compose files. Requires Docker to be available for runtime status.
 *
 * If no apps are specified, shows containers for all apps that have a
 * rendered compose file. Uses the rendered compose from rendersDir if
 * it exists; otherwise falls back to the source compose in the app dir.
 *
 * Flags:
 *   --all   include apps without rendered compose (use source compose)
 *   --json  output as JSON
 *
 * Exit codes:
 *   0 -- success (even if some apps have no running containers)
 *   1 -- docker compose command failed or no apps found
 */

import { Command } from "commander";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discoverApps, type DiscoveredApp } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { pad } from "../utils/formatting.js";
import { resolveComposeFile } from "../utils/paths.js";
import { cliContainerBin } from "../utils/docker.js";

const execFileAsync = promisify(execFile);

/** Container status returned from docker compose ps. */
interface ContainerInfo {
  app: string;
  name: string;
  service: string;
  status: string;
  state: string;
  ports: string;
}

/**
 * Run `docker compose ps --format json` for a given compose file
 * and return parsed container info.
 */
async function getContainerStatus(
  app: DiscoveredApp,
  composeFile: string,
): Promise<ContainerInfo[]> {
  try {
    const { stdout } = await execFileAsync(cliContainerBin(), [
      "compose",
      "-f",
      composeFile,
      "ps",
      "--format",
      "json",
    ]);

    if (!stdout.trim()) {
      return [];
    }

    // docker compose ps --format json outputs one JSON object per line,
    // or a JSON array depending on version.
    const containers: ContainerInfo[] = [];
    const trimmed = stdout.trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Try parsing line-by-line (older docker compose format).
      const lines = trimmed.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          containers.push({
            app: app.name,
            name: String(obj.Name ?? obj.name ?? ""),
            service: String(obj.Service ?? obj.service ?? ""),
            status: String(obj.Status ?? obj.status ?? ""),
            state: String(obj.State ?? obj.state ?? ""),
            ports: formatPorts(obj.Ports ?? obj.ports ?? obj.Publishers ?? obj.publishers),
          });
        } catch {
          // Skip unparseable lines.
        }
      }
      return containers;
    }

    // Handle array or single object.
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const obj of items) {
      if (obj && typeof obj === "object") {
        const rec = obj as Record<string, unknown>;
        containers.push({
          app: app.name,
          name: String(rec.Name ?? rec.name ?? ""),
          service: String(rec.Service ?? rec.service ?? ""),
          status: String(rec.Status ?? rec.status ?? ""),
          state: String(rec.State ?? rec.state ?? ""),
          ports: formatPorts(rec.Ports ?? rec.ports ?? rec.Publishers ?? rec.publishers),
        });
      }
    }

    return containers;
  } catch {
    // docker compose ps failed (no containers, compose not valid, etc.)
    return [];
  }
}

/**
 * Format port information from docker compose ps JSON output.
 * Handles both string and array-of-objects formats.
 */
export function formatPorts(ports: unknown): string {
  if (typeof ports === "string") return ports;
  if (Array.isArray(ports)) {
    return ports
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const pub = p as Record<string, unknown>;
          const published = pub.PublishedPort ?? pub.published_port ?? "";
          const target = pub.TargetPort ?? pub.target_port ?? "";
          const protocol = pub.Protocol ?? pub.protocol ?? "tcp";
          if (published && Number(published) > 0) {
            return `${published}->${target}/${protocol}`;
          }
          return `${target}/${protocol}`;
        }
        return String(p);
      })
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

export const psCommand = new Command("ps")
  .description("Show container status for apps")
  .argument("[apps...]", "specific apps to inspect (default: all)")
  .option("--all", "include apps without rendered compose files")
  .option("--json", "output as JSON")
  .action(async (apps: string[], options: { all?: boolean; json?: boolean }) => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");
    const rendersDir = join(appbayHome, "var", "lib", "renders");

    // Discover all apps from the filesystem.
    const discovered = await discoverApps({ appsDir });

    if (discovered.length === 0) {
      if (options.json) {
        console.log(JSON.stringify([]));
      } else {
        console.log(`No apps found in ${appsDir}`);
      }
      process.exit(0);
    }

    // Filter to requested apps if specified.
    let targets: DiscoveredApp[];
    if (apps.length > 0) {
      const requestedSet = new Set(apps);
      targets = discovered.filter((a) => requestedSet.has(a.name));

      // Warn about app names that were not found.
      const foundNames = new Set(targets.map((a) => a.name));
      for (const name of apps) {
        if (!foundNames.has(name)) {
          if (!options.json) {
            console.error(`  Warning: app "${name}" not found`);
          }
        }
      }
    } else {
      targets = discovered;
    }

    if (targets.length === 0) {
      if (options.json) {
        console.log(JSON.stringify([]));
      } else {
        console.log("No matching apps found.");
      }
      process.exit(1);
    }

    // Collect container status for all target apps.
    const allContainers: ContainerInfo[] = [];

    for (const app of targets) {
      const composeFile = await resolveComposeFile(app.name, app.composePath, rendersDir);
      const containers = await getContainerStatus(app, composeFile);
      allContainers.push(...containers);
    }

    // JSON output mode.
    if (options.json) {
      console.log(JSON.stringify(allContainers, null, 2));
      process.exit(0);
    }

    // Table output mode.
    if (allContainers.length === 0) {
      console.log("No running containers found.");
      process.exit(0);
    }

    const appWidth = Math.max(8, ...allContainers.map((c) => c.app.length + 1));
    const nameWidth = Math.max(14, ...allContainers.map((c) => c.name.length + 1));
    const serviceWidth = Math.max(10, ...allContainers.map((c) => c.service.length + 1));
    const stateWidth = Math.max(8, ...allContainers.map((c) => c.state.length + 1));
    const statusWidth = Math.max(10, ...allContainers.map((c) => c.status.length + 1));

    // Header.
    console.log(
      `  ${pad("APP", appWidth)} ${pad("NAME", nameWidth)} ${pad("SERVICE", serviceWidth)} ${pad("STATE", stateWidth)} ${pad("STATUS", statusWidth)} ${"PORTS"}`,
    );
    console.log(
      `  ${pad("---", appWidth)} ${pad("----", nameWidth)} ${pad("-------", serviceWidth)} ${pad("-----", stateWidth)} ${pad("------", statusWidth)} ${"-----"}`,
    );

    for (const c of allContainers) {
      console.log(
        `  ${pad(c.app, appWidth)} ${pad(c.name, nameWidth)} ${pad(c.service, serviceWidth)} ${pad(c.state, stateWidth)} ${pad(c.status, statusWidth)} ${c.ports}`,
      );
    }

    console.log(`\n${allContainers.length} container(s)`);
  });
