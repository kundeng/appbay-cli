/**
 * `appbay up [apps...] --all --collection <name>` command.
 *
 * Thin CLI wrapper over @appbay/core deploy-service.
 * Contains only argument parsing and console output formatting.
 *
 * Exit codes:
 *   0 -- all selected apps deployed successfully
 *   1 -- one or more apps failed to compile or deploy
 */

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  deploy,
  loadProjectVars,
  isSystemApp,
} from "@appbay/core";
import { dockerCompose, discoverRunningApps } from "../utils/docker.js";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { pad } from "../utils/formatting.js";
import { cliContainerBin } from "../utils/docker.js";

export const upCommand = new Command("up")
  .description("Compile and deploy selected apps")
  .argument("[apps...]", "specific apps to deploy (default: all)")
  .option("--all", "deploy all discovered apps")
  .option("--collection <name>", "deploy only apps in this collection")
  .option("--tail", "tail logs after deploy")
  .option("--open", "open in browser after deploy")
  .action(async (apps: string[], options: { all?: boolean; collection?: string; tail?: boolean; open?: boolean }) => {
    const appbayHome = resolveAppbayHome();

    // Resolve target apps
    let targetApps: string[] | undefined;
    if (options.collection) {
      // deploy-service handles collection filtering
      targetApps = undefined;
    } else if (apps.length > 0) {
      targetApps = apps;
    } else {
      targetApps = undefined; // all
    }

    if (options.collection) {
      console.log(`Deploying apps in collection "${options.collection}"...\n`);
    }

    console.log("Compiling apps...\n");

    const projectVars = await loadProjectVars(appbayHome);

    const result = await deploy({
      appbayHome,
      targetApps,
      collection: options.collection,
      projectVars,
      dockerCompose: (subArgs, composePath, env) => {
        return dockerCompose(subArgs, composePath, env);
      },
      discoverRunning: () => discoverRunningApps(),
    });

    // Report compile errors
    if (result.compileErrors.length > 0) {
      console.error("Compile errors:");
      for (const err of result.compileErrors) {
        const prefix = err.appName ? `[${err.appName}]` : "[global]";
        console.error(`  ${prefix} ${err.stage}: ${err.message}`);
      }
    }

    if (result.apps.length === 0 && result.compileErrors.length > 0) {
      process.exit(1);
    }

    if (result.apps.length === 0) {
      console.log("No apps found to deploy.");
      process.exit(0);
    }

    // Report per-app results
    for (const app of result.apps) {
      const statusLabel = app.planStatus === "new" ? "NEW"
        : app.planStatus === "changed" ? "CHANGED"
        : "UNCHANGED";
      const sysTag = app.isSystem ? " (system)" : "";

      if (app.status === "deployed") {
        console.log(`  ${pad(app.appName, 14)} [${statusLabel}]${sysTag}`);
        console.log(`  Started ${app.appName}`);

        if (app.hookResult?.ran && app.hookResult.error) {
          console.error(`  Post-deploy hook failed for ${app.appName}: ${app.hookResult.error}`);
        } else if (app.hookResult?.ran) {
          console.log(`  Post-deploy verified ${app.appName}`);
        }
      } else if (app.status === "failed") {
        console.error(`  Failed: ${app.appName} — ${app.error}`);
      } else {
        console.log(`  - ${pad(app.appName, 14)} [${statusLabel}]`);
      }
    }

    // Warnings
    if (result.warnings?.length) {
      console.log("");
      for (const warn of result.warnings) {
        console.log(`  ⚠ ${warn}`);
      }
    }

    // Summary
    //
    // 🚨 `failed` MUST be counted here. It used to report only compileErrors.length, so a
    // deploy that printed "Failed: hello — no such image" one line earlier then summarised
    // itself as "0 deployed, 0 unchanged, 0 ERROR(S)". The very next line already knew
    // better — hasFailures reads result.failed — so the summary was contradicting a value
    // in scope two lines below it. A trailing "0 errors" is what a human and a CI log
    // scraper both read as success, which makes this worse than printing nothing.
    //
    // Compile and deploy failures are counted separately because they fail at different
    // stages and are fixed in different places: a compile error is a bad appbay.yaml or
    // overlay, a deploy failure is the runtime refusing the rendered file.
    const errorCount = result.failed + result.compileErrors.length;
    console.log(
      `\n${result.deployed} deployed, ${result.unchanged} unchanged, ${errorCount} error(s)`,
    );

    const hasFailures = result.failed > 0 || result.compileErrors.length > 0;

    if (!hasFailures && options.open && apps.length === 1) {
      const { exec } = await import("node:child_process");
      const appName = apps[0];
      exec(`appbay open ${appName}`);
    }

    if (!hasFailures && options.tail && apps.length > 0) {
      const appName = apps[0];
      const composePath = join(resolveAppbayHome(), "var", "lib", "renders", appName, "docker-compose.rendered.yml");
      spawnSync(cliContainerBin(), ["compose", "-f", composePath, "logs", "-f"], { stdio: "inherit" });
    }

    process.exit(hasFailures ? 1 : 0);
  });
