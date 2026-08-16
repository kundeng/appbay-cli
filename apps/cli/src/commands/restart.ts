/**
 * `appbay restart [apps...] --all` command.
 *
 * Restarts selected apps by running `docker compose down` followed by a
 * full compile and `docker compose up -d`. This is equivalent to running
 * `appbay down` then `appbay up` for the same set of apps.
 *
 * Exit codes:
 *   0 -- all selected apps restarted successfully
 *   1 -- one or more apps failed during down or up
 */

import { Command } from "commander";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import {
  compile,
  discoverApps,
  type CompileResult,
  type AppCompileResult, loadProjectVars , detectRuntimeFacts } from "@appbay/core";
import { dockerCompose } from "../utils/docker.js";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { pad } from "../utils/formatting.js";

/**
 * Write rendered compile output to the renders directory.
 * Creates the directory structure and writes compose + auxiliary files.
 * Returns the path to the rendered compose file.
 */
async function writeRenderedOutput(
  app: AppCompileResult,
  rendersDir: string,
): Promise<string> {
  const appDir = join(rendersDir, app.appName);
  await mkdir(appDir, { recursive: true });

  const composePath = join(appDir, "docker-compose.rendered.yml");

  // Write the rendered compose file.
  await writeFile(composePath, app.rendered, "utf-8");

  // Write auxiliary files (e.g., Traefik configs).
  for (const aux of app.auxiliaryFiles) {
    const auxPath = join(appDir, aux.path);
    const auxDir = auxPath.substring(0, auxPath.lastIndexOf("/"));
    if (auxDir) {
      await mkdir(auxDir, { recursive: true });
    }
    await writeFile(auxPath, aux.content, "utf-8");
  }

  return composePath;
}

export const restartCommand = new Command("restart")
  .description("Restart selected apps (down then up)")
  .argument("[apps...]", "specific apps to restart (default: all)")
  .option("--all", "restart all discovered apps")
  .action(async (apps: string[], options: { all?: boolean }) => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");
    const rendersDir = join(appbayHome, "var", "lib", "renders");
    const stateDir = join(appbayHome, "var", "lib", "state");

    // Discover apps to determine which to restart.
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
    let targetNames: string[] | undefined;
    if (apps.length > 0) {
      targetNames = apps;

      // Warn about apps that were requested but not found.
      for (const name of apps) {
        if (!discovered.some((app) => app.name === name)) {
          console.warn(`  Warning: app "${name}" not found`);
        }
      }
    }

    // Phase 1: Down -- stop apps that have a rendered compose file.
    console.log("Stopping apps...\n");

    const appsToStop = targetNames
      ? discovered.filter((app) => targetNames!.includes(app.name))
      : discovered;

    let hasFailures = false;

    for (const app of appsToStop) {
      const composePath = join(
        rendersDir,
        app.name,
        "docker-compose.rendered.yml",
      );

      // Check if rendered compose exists before attempting to stop.
      let exists = false;
      try {
        const info = await stat(composePath);
        exists = info.isFile();
      } catch {
        // File does not exist.
      }

      if (!exists) {
        console.log(`  - ${pad(app.name, 14)} (no rendered compose, skipped down)`);
        continue;
      }

      console.log(`  Stopping ${app.name}...`);
      const downResult = dockerCompose(["down"], composePath);

      if (downResult.exitCode !== 0) {
        console.error(`  Failed to stop ${app.name} (exit ${downResult.exitCode}):`);
        console.error(`    ${downResult.output}`);
        hasFailures = true;
      } else {
        console.log(`  Stopped ${app.name}`);
      }
    }

    // Phase 2: Up -- compile and deploy.
    console.log("\nCompiling and starting apps...\n");

    let result: CompileResult;
    try {
      // 🚨 projectVars IS NOT OPTIONAL IN PRACTICE. Without it every `${{project.X}}`
      // reference fails to resolve, and essentially every app has one — an ingress trait
      // host is `${{project.DOMAIN}}`. Omitting it made this command fail with
      //   Undefined variable "DOMAIN" in scope "project"
      // on apps that `appbay compile` handled fine, because compile.ts passed it and this
      // did not. Found by the BDD suite (S26 2.2), not by any unit test.
      result = await compile({
        appsDir,
        rendersDir,
        stateDir,
        apps: targetNames,
        projectVars: await loadProjectVars(appbayHome),
        // 🚨 WITHOUT THIS THE COMPILER SEES A HOST WITH NO GPU. `compile()` falls back to
        // DEFAULT_RUNTIME_FACTS (`gpu.available: false`) when facts are absent, and NO caller
        // passed them — so the gpu trait threw "no GPU detected on the host" on every host,
        // including one with a working GPU. Measured on an RTX 5070 Ti, driver 580.82.09.
        runtimeFacts: detectRuntimeFacts({ stateDir }),
      });
    } catch (err) {
      console.error(
        `Compile failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }

    // Report compile errors.
    if (result.errors.length > 0) {
      console.error("Compile errors:");
      for (const err of result.errors) {
        const prefix = err.appName ? `[${err.appName}]` : "[global]";
        console.error(`  ${prefix} ${err.stage}: ${err.message}`);
      }
      hasFailures = true;
    }

    if (result.apps.length === 0) {
      console.log("No apps found to start.");
      process.exit(hasFailures ? 1 : 0);
    }

    let deployed = 0;

    for (const app of result.apps) {
      // Write rendered compose to rendersDir.
      let composePath: string;
      try {
        composePath = await writeRenderedOutput(app, rendersDir);
      } catch (err) {
        console.error(
          `  Failed to write rendered output for ${app.appName}: ${err instanceof Error ? err.message : String(err)}`,
        );
        hasFailures = true;
        continue;
      }

      // Run docker compose up -d.
      console.log(`  Starting ${app.appName}...`);
      const upResult = dockerCompose(["up", "-d"], composePath);

      if (upResult.exitCode !== 0) {
        console.error(`  Failed to start ${app.appName} (exit ${upResult.exitCode}):`);
        console.error(`    ${upResult.output}`);
        hasFailures = true;
      } else {
        console.log(`  Started ${app.appName}`);
        deployed++;
      }
    }

    // Summary.
    console.log(
      `\n${deployed} restarted, ${result.errors.length} error(s)`,
    );

    process.exit(hasFailures ? 1 : 0);
  });
