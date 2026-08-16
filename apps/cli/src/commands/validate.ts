/**
 * `appbay validate [apps...]` command.
 *
 * Offline-capable validation of appbay.yaml and compose files using Zod
 * schemas from @appbay/core. Does not require the server to be running.
 *
 * Exit codes:
 *   0 -- all validated apps passed
 *   1 -- one or more apps failed validation
 */

import { Command } from "commander";
import { join } from "node:path";
import { discoverApps, type DiscoveredApp } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { formatZodIssue, formatErrorMessage } from "./validate-utils.js";
import { pad } from "../utils/formatting.js";
export { formatZodIssue };

export const validateCommand = new Command("validate")
  .description("Validate appbay.yaml and compose files")
  .argument("[apps...]", "specific apps to validate")
  .option("--all", "validate all discovered apps")
  .action(async (apps: string[], options: { all?: boolean }) => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");

    console.log(`Validating apps in ${appsDir}...\n`);

    // Discover all apps from the filesystem.
    const discovered = await discoverApps({ appsDir });

    if (discovered.length === 0) {
      console.log("  No apps found.");
      process.exit(0);
    }

    // Filter to requested apps, or use all if --all or no args given.
    let targets: DiscoveredApp[];
    if (apps.length > 0) {
      const requestedSet = new Set(apps);
      targets = discovered.filter((app) => requestedSet.has(app.name));

      // Warn about app names that were not found.
      const foundNames = new Set(targets.map((a) => a.name));
      for (const name of apps) {
        if (!foundNames.has(name)) {
          console.log(`  ? ${name}        — not found in ${appsDir}`);
        }
      }
    } else if (options.all) {
      targets = discovered;
    } else {
      // Default: validate all discovered apps (same as --all).
      targets = discovered;
    }

    if (targets.length === 0) {
      console.log("  No matching apps to validate.");
      process.exit(1);
    }

    let passed = 0;
    let failed = 0;

    for (const app of targets) {
      if (app.errors.length === 0) {
        // Determine description based on whether appbay.yaml exists.
        const desc = app.appbayConfig
          ? "appbay.yaml valid, compose valid"
          : "compose only (no appbay.yaml)";
        console.log(`  \u2713 ${pad(app.name, 14)} — ${desc}`);
        passed++;
      } else {
        // Report the first error line inline, additional errors indented.
        const firstError = app.errors[0];
        const firstMsg = formatErrorMessage(firstError);
        console.log(`  \u2717 ${pad(app.name, 14)} — ${firstMsg}`);

        // Print remaining errors indented.
        for (let i = 1; i < app.errors.length; i++) {
          const msg = formatErrorMessage(app.errors[i]);
          console.log(`${" ".repeat(20)}${msg}`);
        }
        failed++;
      }
    }

    console.log(`\n${passed} passed, ${failed} failed`);

    process.exit(failed > 0 ? 1 : 0);
  });


