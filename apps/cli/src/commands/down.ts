/**
 * `appbay down [apps...] --all` command.
 *
 * Stops selected apps by running `docker compose down` against their
 * rendered compose files in the renders directory.
 *
 * Exit codes:
 *   0 -- all selected apps stopped successfully
 *   1 -- one or more apps failed to stop or no rendered compose found
 */

import { Command } from "commander";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { discoverApps, isSystemApp } from "@appbay/core";
import { dockerCompose } from "../utils/docker.js";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { pad } from "../utils/formatting.js";

/**
 * Check whether a rendered compose file exists for an app.
 */
async function renderedComposeExists(composePath: string): Promise<boolean> {
  try {
    const info = await stat(composePath);
    return info.isFile();
  } catch {
    return false;
  }
}

export const downCommand = new Command("down")
  .description("Stop selected apps")
  .argument("[apps...]", "specific apps to stop (default: all)")
  .option("--all", "stop all discovered apps")
  .action(async (apps: string[], options: { all?: boolean }) => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");
    const rendersDir = join(appbayHome, "var", "lib", "renders");

    // Discover apps to determine which to stop.
    let discovered;
    try {
      discovered = await discoverApps({ appsDir });
    } catch (err) {
      console.error(
        `Discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }

    // Filter to requested apps if specified.
    let targetApps = discovered;
    if (apps.length > 0) {
      const requested = new Set(apps);
      targetApps = discovered.filter((app) => requested.has(app.name));

      // Warn about apps that were requested but not found.
      for (const name of apps) {
        if (!discovered.some((app) => app.name === name)) {
          console.warn(`  Warning: app "${name}" not found`);
        }
      }
    }

    if (targetApps.length === 0) {
      console.log("No apps found to stop.");
      process.exit(0);
    }

    // Reverse boot order: user apps first, system apps last.
    const userApps = targetApps.filter((a) => !isSystemApp(a.name));
    const systemApps = targetApps.filter((a) => isSystemApp(a.name)).reverse();
    const orderedApps = [...userApps, ...systemApps];

    console.log("Stopping apps...\n");

    let hasFailures = false;
    let stopped = 0;

    for (const app of orderedApps) {
      const composePath = join(
        rendersDir,
        app.name,
        "docker-compose.rendered.yml",
      );

      // Check if the rendered compose exists.
      const exists = await renderedComposeExists(composePath);
      if (!exists) {
        console.log(`  - ${pad(app.name, 14)} (no rendered compose, skipped)`);
        continue;
      }

      // Run docker compose down.
      console.log(`  Stopping ${app.name}...`);
      const result = dockerCompose(["down"], composePath);

      if (result.exitCode !== 0) {
        console.error(`  Failed to stop ${app.name} (exit ${result.exitCode}):`);
        console.error(`    ${result.output}`);
        hasFailures = true;
      } else {
        console.log(`  Stopped ${app.name}`);
        stopped++;
      }
    }

    // Summary.
    console.log(`\n${stopped} stopped`);

    process.exit(hasFailures ? 1 : 0);
  });
