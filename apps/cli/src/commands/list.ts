/**
 * `appbay list` command.
 *
 * Offline-capable discovery of all apps using @appbay/core directly.
 * Shows app name, project, environment, whether appbay.yaml exists,
 * and the compose file name.
 *
 * Flags:
 *   --all   include apps with discovery errors (shown by default anyway)
 *   --json  output as a JSON array
 *
 * Exit codes:
 *   0 -- always (discovery is best-effort)
 */

import { Command } from "commander";
import { join, basename } from "node:path";
import { discoverApps, type DiscoveredApp } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { pad } from "../utils/formatting.js";

/**
 * Build a JSON-serializable record for a discovered app.
 */
export function appToJson(app: DiscoveredApp): Record<string, unknown> {
  return {
    name: app.name,
    project: app.appbayConfig?.project ?? "default",
    environment: app.appbayConfig?.environment ?? "default",
    hasAppbayYaml: app.appbayConfig !== null,
    composeFile: basename(app.composePath),
    dir: app.dir,
    errors: app.errors.length,
  };
}

export const listCommand = new Command("list")
  .description("List all discovered apps")
  .option("--all", "include apps with discovery errors")
  .option("--json", "output as JSON array")
  .action(async (options: { all?: boolean; json?: boolean }) => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");

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

    // Filter: when --all is not set, still show all apps but flag errors.
    // The --all flag is accepted for interface parity but discovery always
    // returns everything; the flag is a no-op by design.
    const targets = discovered;

    // JSON output mode.
    if (options.json) {
      console.log(JSON.stringify(targets.map(appToJson), null, 2));
      process.exit(0);
    }

    // Table output mode.
    const nameWidth = Math.max(14, ...targets.map((a) => a.name.length + 1));
    const projectWidth = Math.max(10, ...targets.map((a) => (a.appbayConfig?.project ?? "default").length + 1));
    const envWidth = Math.max(12, ...targets.map((a) => (a.appbayConfig?.environment ?? "default").length + 1));

    // Header.
    console.log(
      `  ${pad("NAME", nameWidth)} ${pad("PROJECT", projectWidth)} ${pad("ENVIRONMENT", envWidth)} ${"APPBAY.YAML"}  ${"COMPOSE FILE"}`,
    );
    console.log(
      `  ${pad("----", nameWidth)} ${pad("-------", projectWidth)} ${pad("-----------", envWidth)} ${"----------"}   ${"------------"}`,
    );

    for (const app of targets) {
      const project = app.appbayConfig?.project ?? "default";
      const env = app.appbayConfig?.environment ?? "default";
      const hasConfig = app.appbayConfig !== null ? "yes" : "no";
      const composeFile = basename(app.composePath);
      const errorSuffix = app.errors.length > 0 ? `  (${app.errors.length} error(s))` : "";

      console.log(
        `  ${pad(app.name, nameWidth)} ${pad(project, projectWidth)} ${pad(env, envWidth)} ${pad(hasConfig, 12)} ${composeFile}${errorSuffix}`,
      );
    }

    console.log(`\n${targets.length} app(s) found`);
  });
