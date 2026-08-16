/**
 * `appbay apply [apps...] --dry-run --yes` — apply a compiled plan.
 *
 * Unlike `up` which compiles + deploys in one step, `apply` works with
 * a previously compiled plan. Useful for review-then-apply workflows.
 */
import { Command } from "commander";
import { compile, type CompileResult, loadProjectVars , detectRuntimeFacts } from "@appbay/core";
import {
  resolveAppsDir,
  resolveRendersDir,
  resolveStateDir, resolveAppbayHome } from "../utils/appbay-home.js";
import { dockerCompose, discoverRunningApps } from "../utils/docker.js";
import { join, dirname } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";

export const applyCommand = new Command("apply")
  .description("Apply a deployment plan (compile → review → deploy)")
  .argument("[apps...]", "specific apps to apply")
  .option("--dry-run", "show what would change without deploying")
  .option("--yes", "skip confirmation")
  .option("--all", "apply all apps")
  .action(async (apps: string[], options: { dryRun?: boolean; yes?: boolean; all?: boolean }) => {
    const appsDir = resolveAppsDir();
    const rendersDir = resolveRendersDir();
    const stateDir = resolveStateDir();

    const targetApps = apps.length > 0 ? apps : undefined;

    console.log("Compiling plan...\n");

    const activeApps = discoverRunningApps();

    let result: CompileResult;
    try {
      // 🚨 projectVars IS NOT OPTIONAL IN PRACTICE. Without it every `${{project.X}}`
      // reference fails to resolve, and essentially every app has one — an ingress trait
      // host is `${{project.DOMAIN}}`. Omitting it made this command fail with
      //   Undefined variable "DOMAIN" in scope "project"
      // on apps that `appbay compile` handled fine, because compile.ts passed it and this
      // did not. Found by the BDD suite (S26 2.2), not by any unit test.
      // runtimeFacts: see the note in compile.ts — without it the gpu trait sees no GPU.
      result = await compile({ appsDir, rendersDir, stateDir, apps: targetApps, activeApps, projectVars: await loadProjectVars(resolveAppbayHome()), runtimeFacts: detectRuntimeFacts({ stateDir }) });
    } catch (err) {
      console.error(`Compile failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // Show plan
    const changed = result.apps.filter(a => a.plan.status === "new" || a.plan.status === "changed");
    const unchanged = result.apps.filter(a => a.plan.status === "unchanged");

    if (changed.length === 0) {
      console.log("No changes detected. All apps are up to date.");
      if (unchanged.length > 0) {
        console.log(`  ${unchanged.length} app(s) unchanged`);
      }
      return;
    }

    console.log(`Plan: ${changed.length} change(s), ${unchanged.length} unchanged\n`);

    for (const app of changed) {
      const label = app.plan.status === "new" ? "NEW" : "CHANGED";
      console.log(`  [${label}] ${app.appName}`);
      if (app.plan.diff) {
        const lines = app.plan.diff.split("\n").slice(0, 15);
        for (const line of lines) {
          console.log(`    ${line}`);
        }
        const total = app.plan.diff.split("\n").length;
        if (total > 15) console.log(`    ... (${total - 15} more lines)`);
      }
      console.log("");
    }

    if (options.dryRun) {
      console.log("Dry run — no changes applied.");
      return;
    }

    if (!options.yes) {
      console.log("Use --yes to apply this plan, or --dry-run to preview only.");
      return;
    }

    // Apply
    console.log("Applying...\n");
    let deployed = 0;

    for (const app of changed) {
      const renderDir = join(rendersDir, app.appName);
      const composePath = join(renderDir, "docker-compose.rendered.yml");

      await mkdir(renderDir, { recursive: true });
      await writeFile(composePath, app.rendered);

      // Write auxiliary files
      for (const aux of app.auxiliaryFiles) {
        const auxPath = join(renderDir, aux.path);
        await mkdir(dirname(auxPath), { recursive: true });
        await writeFile(auxPath, aux.content);
      }

      // Ensure .env exists
      const appEnvPath = join(appsDir, app.appName, ".env");
      try {
        await writeFile(appEnvPath, "", { flag: "a" });
      } catch { /* ignore */ }

      console.log(`  Deploying ${app.appName}...`);
      const dc = dockerCompose(["up", "-d"], composePath);
      if (dc.exitCode === 0) {
        console.log(`    deployed`);
        deployed++;
      } else {
        console.error(`    failed: ${dc.output.trim().split("\n")[0]}`);
      }
    }

    console.log(`\n${deployed} deployed, ${result.errors.length} error(s)`);
    process.exit(result.errors.length > 0 ? 1 : 0);
  });
