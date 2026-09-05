/**
 * `appbay ps [apps...]` command.
 *
 * Shows container status from `compose ps` against rendered compose files, parsed by
 * the runtime adapter so Docker Compose and podman-compose output read the same.
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
import { discoverApps, composePs, type DiscoveredApp } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { pad } from "../utils/formatting.js";
import { resolveComposeFile } from "../utils/paths.js";
import { dockerCompose } from "../utils/docker.js";


/** Container status returned from docker compose ps. */
interface ContainerInfo {
  app: string;
  name: string;
  service: string;
  status: string;
  state: string;
  ports: string;
}

/** Container rows for one app, through the runtime adapter's one compose-ps parser. */
function getContainerStatus(app: DiscoveredApp, composeFile: string): ContainerInfo[] {
  // Running containers only, as `ps` has always shown; `up` asks with `all` for its own reasons.
  const rows = composePs((args, path, env) => dockerCompose(args, path, env), composeFile, {}, { all: false });
  if (rows.kind === "unknown") {
    console.error(`  ${app.name}: could not ask compose (${rows.reason})`);
    return [];
  }
  return rows.value.map((r) => ({ app: app.name, name: r.name, service: r.service, status: r.status, state: r.state, ports: r.ports }));
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
