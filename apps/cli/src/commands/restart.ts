/**
 * `appbay restart [apps...] --all`: `down` then `up` for the same apps, through the same
 * two paths those commands use. The start half is `deploy()`, so a restarted app is
 * observed after `up -d` and its edge route is installed; a private copy of the render
 * writer used to put route fragments under `renders/` where no edge reads them.
 *
 * Exit codes: 0 when every selected app stopped and deployed; 1 otherwise.
 */

import { Command } from "commander";
import { deploy, loadProjectVars } from "@appbay/core";
import { dockerCompose } from "../utils/docker.js";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { printDeployReport } from "../utils/deploy-report.js";
import { stopApps } from "./down.js";

export const restartCommand = new Command("restart")
  .description("Restart selected apps (down then up)")
  .argument("[apps...]", "specific apps to restart (default: all)")
  .option("--all", "restart all discovered apps")
  .action(async (apps: string[]) => {
    const appbayHome = resolveAppbayHome();

    console.log("Stopping apps...\n");
    let stopFailed = 0;
    try {
      const stop = await stopApps(appbayHome, apps);
      for (const name of stop.unknown) console.warn(`  Warning: app "${name}" not found`);
      stopFailed = stop.failed;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    console.log("\nCompiling and starting apps...\n");
    const result = await deploy({
      appbayHome,
      targetApps: apps.length > 0 ? apps : undefined,
      projectVars: await loadProjectVars(appbayHome),
      dockerCompose: (subArgs, composePath, env) => dockerCompose(subArgs, composePath, env),
    });

    if (result.compileErrors.length > 0) {
      console.error("Compile errors:");
      for (const err of result.compileErrors) {
        console.error(`  ${err.appName ? `[${err.appName}]` : "[global]"} ${err.stage}: ${err.message}`);
      }
    }
    if (result.apps.length === 0) {
      console.log(result.compileErrors.length > 0 ? "" : "No apps found to start.");
      process.exit(result.compileErrors.length > 0 || stopFailed > 0 ? 1 : 0);
    }

    const { hasFailures } = printDeployReport(result);
    process.exit(hasFailures || stopFailed > 0 ? 1 : 0);
  });
