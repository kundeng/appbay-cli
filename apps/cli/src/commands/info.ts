/**
 * `appbay info` command.
 *
 * Prints system information relevant to Appbay:
 *   - OS platform and architecture
 *   - Docker version
 *   - Docker Compose version
 *   - GPU availability (nvidia-smi)
 *   - APPBAY_HOME path
 *   - Number of discovered apps
 *
 * Exit codes:
 *   0 -- always
 */

import { Command } from "commander";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { platform, arch, release } from "node:os";
import { VERSION } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { tryExec, versions } from "@appbay/core";

/** Run a host tool (uname, sw_vers, …), returning a fallback string on failure. */
function tryExecOrFallback(command: string, args: string[], fallback = "not available"): string {
  return tryExec(command, args) ?? fallback;
}

/**
 * Count the number of app directories in the apps folder.
 */
async function countApps(appsDir: string): Promise<number> {
  try {
    const entries = await readdir(appsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

export const infoCommand = new Command("info")
  .description("Print system information")
  .action(async () => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");
    const appCount = await countApps(appsDir);

    const probed = versions(appbayHome);
    const dockerVersion = probed.runtime ?? "not available";
    const composeVersion = probed.compose ?? "not available";
    const gpuInfo = tryExecOrFallback(
      "nvidia-smi",
      ["--query-gpu=name", "--format=csv,noheader"],
      "none detected",
    );

    console.log("Appbay System Info\n");
    console.log(`  Appbay version:  ${VERSION}`);
    console.log(`  OS:              ${platform()} ${arch()} (${release()})`);
    console.log(`  Docker:          ${dockerVersion}`);
    console.log(`  Compose:         ${composeVersion}`);
    console.log(`  GPU:             ${gpuInfo}`);
    console.log(`  APPBAY_HOME:     ${appbayHome}`);
    console.log(`  Apps:            ${appCount}`);
  });
