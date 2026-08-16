/**
 * `appbay compile [apps...]` command.
 *
 * Offline-capable compilation of app definitions through the full compiler
 * pipeline from @appbay/core. Does not require the server to be running.
 *
 * Resolves APPBAY_HOME, calls compile(), and outputs per-app results with
 * status and diff preview. If --output is specified, writes rendered compose
 * and auxiliary files to that directory instead of the default rendersDir.
 *
 * Exit codes:
 *   0 -- all apps compiled successfully
 *   1 -- one or more apps had errors
 */

import { Command } from "commander";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { compile, loadProjectVars, type CompileResult, type AppCompileResult , detectRuntimeFacts } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { discoverRunningApps } from "../utils/docker.js";
import { pad } from "../utils/formatting.js";

/**
 * Write rendered compile output to a target directory.
 * Creates the directory structure and writes compose + auxiliary files.
 */
async function writeCompileOutput(
  app: AppCompileResult,
  outputDir: string,
): Promise<void> {
  const appDir = join(outputDir, app.appName);
  await mkdir(appDir, { recursive: true });

  // Write the rendered compose file.
  await writeFile(
    join(appDir, "docker-compose.rendered.yml"),
    app.rendered,
    "utf-8",
  );

  // Write auxiliary files (e.g., Traefik configs).
  for (const aux of app.auxiliaryFiles) {
    const auxPath = join(appDir, aux.path);
    const auxDir = auxPath.substring(0, auxPath.lastIndexOf("/"));
    if (auxDir) {
      await mkdir(auxDir, { recursive: true });
    }
    await writeFile(auxPath, aux.content, "utf-8");
  }
}

export const compileCommand = new Command("compile")
  .description("Compile app definitions into rendered compose files")
  .argument("[apps...]", "specific apps to compile (default: all)")
  .option("--output <dir>", "write rendered output to this directory")
  .action(async (apps: string[], options: { output?: string }) => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");
    const rendersDir = join(appbayHome, "var", "lib", "renders");
    const stateDir = join(appbayHome, "var", "lib", "state");

    console.log(`Compiling apps from ${appsDir}...\n`);

    // Discover currently running apps so conditional overlays fire correctly.
    const activeApps = discoverRunningApps();
    if (activeApps.size > 0) {
      console.log(`  Active apps: ${[...activeApps].join(", ")}\n`);
    }

    // Load project variables so ${{project.DOMAIN}} etc. resolve correctly.
    const projectVars = await loadProjectVars(appbayHome);

    // Run the full compiler pipeline.
    let result: CompileResult;
    try {
      result = await compile({
        appsDir,
        rendersDir,
        stateDir,
        apps: apps.length > 0 ? apps : undefined,
        activeApps,
        projectVars,
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

    // If no apps were found at all, report and exit.
    if (result.apps.length === 0 && result.errors.length === 0) {
      console.log("  No apps found to compile.");
      process.exit(0);
    }

    // Determine the output directory for rendered files.
    const outputDir = options.output ?? rendersDir;

    // Write rendered output for each compiled app.
    for (const app of result.apps) {
      try {
        await writeCompileOutput(app, outputDir);
      } catch (err) {
        console.error(
          `  Failed to write output for ${app.appName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Display per-app results.
    let hasErrors = false;

    for (const app of result.apps) {
      const status = app.plan.status;
      const statusLabel =
        status === "new"
          ? "NEW"
          : status === "changed"
            ? "CHANGED"
            : "UNCHANGED";

      const icon = status === "unchanged" ? "-" : "+";
      console.log(`  ${icon} ${pad(app.appName, 14)} [${statusLabel}]`);

      // Show diff preview (first 20 lines) for new or changed apps.
      if (app.plan.diff) {
        const diffLines = app.plan.diff.split("\n");
        const preview = diffLines.slice(0, 20);
        for (const line of preview) {
          console.log(`    ${line}`);
        }
        if (diffLines.length > 20) {
          console.log(`    ... (${diffLines.length - 20} more lines)`);
        }
      }
    }

    // Report compile errors.
    if (result.errors.length > 0) {
      hasErrors = true;
      console.log("\nErrors:");
      for (const err of result.errors) {
        const prefix = err.appName ? `[${err.appName}]` : "[global]";
        console.log(`  ${prefix} ${err.stage}: ${err.message}`);
      }
    }

    // Report warnings.
    if (result.warnings.length > 0) {
      console.log("\nWarnings:");
      for (const warn of result.warnings) {
        console.log(`  ${warn}`);
      }
    }

    // Summary line.
    const compiled = result.apps.length;
    const errCount = result.errors.length;
    console.log(
      `\n${compiled} compiled, ${errCount} error(s)`,
    );

    if (options.output) {
      console.log(`Output written to ${outputDir}`);
    }

    process.exit(hasErrors ? 1 : 0);
  });
