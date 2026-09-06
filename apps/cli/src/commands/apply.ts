/**
 * `appbay apply [apps...] --dry-run --yes` — apply a compiled plan.
 *
 * Unlike `up` which compiles + deploys in one step, `apply` works with
 * a previously compiled plan. Useful for review-then-apply workflows.
 */
import { Command } from "commander";
import { deploy, type CompileResult, loadProjectVars, compileInstall } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { dockerCompose } from "../utils/docker.js";
import { printDeployReport } from "../utils/deploy-report.js";

export const applyCommand = new Command("apply")
  .description("Apply a deployment plan (compile → review → deploy)")
  .argument("[apps...]", "specific apps to apply")
  .option("--dry-run", "show what would change without deploying")
  .option("--yes", "skip confirmation")
  .option("--all", "apply all apps")
  .option("--namespace <ns>", "namespace for every app whose manifest pins none")
  .action(async (apps: string[], options: { dryRun?: boolean; yes?: boolean; all?: boolean; namespace?: string }) => {
    const targetApps = apps.length > 0 ? apps : undefined;

    console.log("Compiling plan...\n");


    let result: CompileResult;
    try {
      result = await compileInstall(resolveAppbayHome(), { apps: targetApps, namespace: options.namespace });
    } catch (err) {
      console.error(`Compile failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // An app that did not compile is absent from `result.apps`; without this it read as
    // "up to date". The errors are printed the way `up` prints them, and they fail the run.
    if (result.errors.length > 0) {
      console.error("Compile errors:");
      for (const err of result.errors) {
        console.error(`  ${err.appName ? `[${err.appName}]` : "[global]"} ${err.stage}: ${err.message}`);
      }
      process.exit(1);
    }

    const changed = result.apps.filter(a => a.plan.status === "new" || a.plan.status === "changed");
    const unchanged = result.apps.filter(a => a.plan.status === "unchanged");

    // The plan is a verdict about the rendered files. An unchanged render says nothing about
    // whether its container still runs (appbay-cli#4), so with --yes every compiled app is
    // handed to deploy(), which converges it and reports what compose did.
    if (changed.length === 0) {
      console.log(`No plan changes; ${String(unchanged.length)} app(s) have an unchanged render.`);
      if (!options.yes || options.dryRun) {
        if (!options.dryRun) console.log("Use --yes to converge them anyway (a container that is gone is started).");
        return;
      }
    } else {
      console.log(`Plan: ${changed.length} change(s), ${unchanged.length} unchanged\n`);
    }

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
      targetApps: result.apps.map((a) => a.appName),
      namespace: options.namespace,
      projectVars: await loadProjectVars(resolveAppbayHome()),
      dockerCompose: (subArgs, composePath, env) => dockerCompose(subArgs, composePath, env),
    });
    const { hasFailures } = printDeployReport(deployResult);
    process.exit(hasFailures ? 1 : 0);
  });
