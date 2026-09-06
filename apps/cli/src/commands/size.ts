/**
 * `appbay size [app]` — show disk usage for apps.
 */
import { Command } from "commander";
import { discoverApps, apiDiskUsage } from "@appbay/core";
import { resolveAppbayHome, resolveAppsDir } from "../utils/appbay-home.js";
import { formatBytes } from "../utils/formatting.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function getDirSize(dir: string): string {
  const result = spawnSync("du", ["-sh", dir], { encoding: "utf-8" });
  if (result.status !== 0) return "—";
  return (result.stdout as string).trim().split("\t")[0] || "—";
}

/** Volume bytes per compose project, from one `/system/df` read; null when the runtime could not be asked. */
async function volumeBytesByProject(appbayHome: string): Promise<Map<string, number> | null> {
  const usage = await apiDiskUsage({ appbayHome });
  if (usage.kind === "unknown") return null;
  const totals = new Map<string, number>();
  for (const v of usage.value.Volumes ?? []) {
    const project = v.Labels?.["com.docker.compose.project"];
    if (!project) continue;
    totals.set(project, (totals.get(project) ?? 0) + (v.UsageData?.Size ?? 0));
  }
  return totals;
}

export const sizeCommand = new Command("size")
  .description("Show disk usage for apps")
  .argument("[app]", "specific app (default: all)")
  .option("--all", "include system apps")
  .action(async (app?: string, options?: { all?: boolean }) => {
    const home = resolveAppbayHome();
    const appsDir = resolveAppsDir();
    const rendersDir = join(home, "var/lib/renders");

    const discovered = await discoverApps({ appsDir });
    const targets = app
      ? discovered.filter((a) => a.name === app)
      : discovered;

    if (targets.length === 0) {
      console.log(app ? `App "${app}" not found.` : "No apps found.");
      return;
    }

    console.log("Appbay Disk Usage\n");

    const pad = (s: string, n: number) => s.padEnd(n);

    console.log(
      `  ${pad("APP", 20)} ${pad("DEFINITION", 12)} ${pad("RENDERED", 12)} ${pad("VOLUMES", 12)}`,
    );
    console.log(
      `  ${pad("---", 20)} ${pad("----------", 12)} ${pad("--------", 12)} ${pad("-------", 12)}`,
    );

    const volumes = await volumeBytesByProject(home);
    if (volumes === null) console.log("  (volumes: the runtime could not be asked)\n");
    for (const t of targets) {
      const defSize = getDirSize(t.dir);
      const renderSize = getDirSize(join(rendersDir, t.name));
      const volSize = volumes === null ? "?" : formatBytes(volumes.get(t.name) ?? 0);
      console.log(
        `  ${pad(t.name, 20)} ${pad(defSize, 12)} ${pad(renderSize, 12)} ${pad(volSize, 12)}`,
      );
    }

    // Totals
    console.log("");
    console.log(`  APPBAY_HOME:  ${getDirSize(home)}`);
    console.log(`  Definitions:  ${getDirSize(appsDir)}`);
    console.log(`  Renders:      ${getDirSize(rendersDir)}`);
  });
