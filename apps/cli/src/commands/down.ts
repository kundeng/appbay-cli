/**
 * `appbay down [apps...] --all`: `compose down` against each app's rendered file, in the
 * reverse of the start order. `restart` stops through the same function.
 *
 * Exit codes: 0 when every selected app stopped; 1 when one failed to stop.
 */

import { Command } from "commander";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { discoverApps, deployOrder, loadProjects, composeProject, engineObserver } from "@appbay/core";
import { dockerCompose } from "../utils/docker.js";
import { projectOwnershipError, resolveAppbayHome } from "../utils/appbay-home.js";
import { pad } from "../utils/formatting.js";

async function renderedComposeExists(composePath: string): Promise<boolean> {
  try {
    return (await stat(composePath)).isFile();
  } catch {
    return false;
  }
}

interface StopResult {
  /** Apps the install holds, before any filter. */
  found: number;
  stopped: number;
  failed: number;
  /** The requested names no app directory carries. */
  unknown: string[];
}

/**
 * Stop the named apps (every discovered app when `names` is empty) in the reverse of the
 * start order `up` uses: dependents first, the edge everything routes through last. An
 * order that cannot be honoured stops nothing and throws.
 */
export async function stopApps(appbayHome: string, names: string[]): Promise<StopResult> {
  const appsDir = join(appbayHome, "etc", "apps");
  const rendersDir = join(appbayHome, "var", "lib", "renders");
  const observer = engineObserver(appbayHome);
  const discovered = await discoverApps({ appsDir });
  const requested = new Set(names);
  const targets = names.length > 0 ? discovered.filter((app) => requested.has(app.name)) : discovered;
  const unknown = names.filter((name) => !discovered.some((app) => app.name === name));

  const projects = loadProjects(appbayHome);
  if (projects.error) throw new Error(projects.error);
  const graph = deployOrder(
    targets.map((a) => ({ appName: a.name, project: a.appbayConfig?.project ?? "default", app: a })),
    projects.config.projects,
    discovered.map((a) => a.appbayConfig?.project ?? "default"),
  );
  if (graph.errors.length > 0) throw new Error(graph.errors.join("\n"));

  let stopped = 0;
  let failed = 0;
  for (const { app } of [...graph.order].reverse()) {
    const composePath = join(rendersDir, app.name, "docker-compose.rendered.yml");
    const project = composeProject(app.name);
    const hasRender = await renderedComposeExists(composePath);
    const rows = await observer.project(app.name);
    if (rows.kind === "unknown") {
      console.error(`  Failed to stop ${app.name}: could not ask the runtime (${rows.reason})`);
      failed++;
      continue;
    }
    const hasRunningContainer = rows.value.some((row) => row.state === "running");
    if (!hasRender && !hasRunningContainer) {
      console.log(rows.value.length === 0
        ? `  - ${pad(app.name, 14)} (not deployed)`
        : `  - ${pad(app.name, 14)} (${String(rows.value.length)} container(s) exist, none running)`);
      continue;
    }

    // Compose down addresses the whole project, including exited containers. Verify every
    // row before invoking it; a local running row beside a foreign exited row is still unsafe.
    const ownershipError = projectOwnershipError(appbayHome, rows.value);
    if (ownershipError) {
      console.error(`  Failed to stop ${app.name}: project "${project}" is not owned by this Appbay home: ${ownershipError}.`);
      failed++;
      continue;
    }
    console.log(`  Stopping ${app.name}...`);
    const result = dockerCompose(["-p", project, "down"], hasRender ? composePath : app.composePath);
    if (result.exitCode !== 0) {
      console.error(`  Failed to stop ${app.name} (exit ${result.exitCode}):`);
      console.error(`    ${result.output}`);
      failed++;
    } else {
      console.log(`  Stopped ${app.name}`);
      stopped++;
    }
  }
  return { found: discovered.length, stopped, failed, unknown };
}

export const downCommand = new Command("down")
  .description("Stop selected apps")
  .argument("[apps...]", "specific apps to stop (default: all)")
  .option("--all", "stop all discovered apps")
  .action(async (apps: string[]) => {
    console.log("Stopping apps...\n");
    let result: StopResult;
    try {
      result = await stopApps(resolveAppbayHome(), apps);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    for (const name of result.unknown) console.error(`  [${name}] target: no installed app named "${name}"`);
    if (result.found === 0) console.log("No apps found to stop.");
    console.log(`\n${result.stopped} stopped`);
    process.exit(result.failed > 0 || result.unknown.length > 0 ? 1 : 0);
  });
