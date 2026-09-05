/**
 * `appbay apply [apps...] --dry-run --yes` — apply a compiled plan.
 *
 * Unlike `up` which compiles + deploys in one step, `apply` works with
 * a previously compiled plan. Useful for review-then-apply workflows.
 */
import { Command } from "commander";
import { compile, deploy, type CompileResult, loadProjectVars, compileInstall } from "@appbay/core";
import {
  resolveAppsDir,
  resolveRendersDir,
  resolveStateDir, resolveAppbayHome } from "../utils/appbay-home.js";
import { dockerCompose } from "../utils/docker.js";
import { printDeployReport } from "../utils/deploy-report.js";

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


    let result: CompileResult;
    try {
      result = await compileInstall(resolveAppbayHome(), { apps: targetApps });
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

    // Apply — through the one deploy path, so the crash check, the route install and the
    // observed tally are the same ones `appbay up` has (review 2026-09-05, F2).
    console.log("Applying...\n");
    const deployResult = await deploy({
      appbayHome: resolveAppbayHome(),
      targetApps: changed.map((a) => a.appName),
      projectVars: await loadProjectVars(resolveAppbayHome()),
      dockerCompose: (subArgs, composePath, env) => dockerCompose(subArgs, composePath, env),
    });
    const { hasFailures } = printDeployReport(deployResult);
    process.exit(hasFailures || result.errors.length > 0 ? 1 : 0);
  });
