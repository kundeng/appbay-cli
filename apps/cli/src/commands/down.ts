/**
 * `appbay down [apps...] --all`: `compose down` against each app's rendered file, in the
 * reverse of the start order. `restart` stops through the same function.
 *
 * Exit codes: 0 when every selected app stopped; 1 when one failed to stop.
 */

import { Command } from "commander";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { discoverApps, deployOrder, loadProjects, composeProject, containerExec } from "@appbay/core";
import { dockerCompose } from "../utils/docker.js";
import { resolveAppbayHome } from "../utils/appbay-home.js";
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
    console.log(`  Stopping ${app.name}...`);
    // With the project stated, the render is not needed to reach the containers: a project
    // whose render is gone is stopped by name rather than skipped with its containers up.
    const result = (await renderedComposeExists(composePath))
      ? dockerCompose(["-p", project, "down"], composePath)
      : containerExec(["compose", "-p", project, "down"], { appbayHome, timeout: 600_000, label: "compose down" });
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
