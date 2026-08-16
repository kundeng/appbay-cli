/**
 * `appbay size [app]` — show disk usage for apps.
 */
import { Command } from "commander";
import { discoverApps } from "@appbay/core";
import { resolveAppbayHome, resolveAppsDir } from "../utils/appbay-home.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function getDirSize(dir: string): string {
  const result = spawnSync("du", ["-sh", dir], { encoding: "utf-8" });
  if (result.status !== 0) return "—";
  return (result.stdout as string).trim().split("\t")[0] || "—";
}

function getVolumeSize(name: string): string {
  const result = spawnSync(
    "docker",
    ["system", "df", "-v", "--format", "{{.Name}}\t{{.Size}}"],
    { encoding: "utf-8", timeout: 15_000 },
  );
  if (result.status !== 0) return "—";
  const line = (result.stdout as string)
    .trim()
    .split("\n")
    .find((l) => l.startsWith(name + "\t") || l.startsWith(name + " "));
  return line?.split("\t")[1] || "—";
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

    for (const t of targets) {
      const defSize = getDirSize(t.dir);
      const renderSize = getDirSize(join(rendersDir, t.name));
      const volSize = getVolumeSize(t.name);
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
