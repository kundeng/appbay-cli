/**
 * `appbay delete <app>` — remove an app definition.
 */
import { Command } from "commander";
import { resolveAppbayHome, resolveAppsDir } from "../utils/appbay-home.js";
import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
import { dockerCompose } from "../utils/docker.js";

export const deleteCommand = new Command("delete")
  .description("Delete an app definition")
  .argument("<app>", "app to delete")
  .option("--keep-volumes", "keep Docker volumes")
  .option("--force", "skip confirmation")
  .action(async (app: string, options: { keepVolumes?: boolean; force?: boolean }) => {
    const home = resolveAppbayHome();
    const appsDir = resolveAppsDir();
    const appDir = join(appsDir, app);
    const rendersDir = join(home, "var/lib/renders", app);

    // Check app exists
    try {
      await stat(appDir);
    } catch {
      console.error(`App "${app}" not found at ${appDir}`);
      process.exit(1);
    }

    if (!options.force) {
      console.log(`This will delete the app definition at ${appDir}`);
      console.log(`Volumes will be ${options.keepVolumes ? "kept" : "removed"}.`);
      console.log(`Use --force to skip this confirmation.\n`);
      // In a real implementation, prompt for confirmation
      // For now, require --force
      console.error("Use --force to confirm deletion.");
      process.exit(1);
    }

    // Stop containers if running
    const renderCompose = join(rendersDir, "docker-compose.rendered.yml");
    try {
      await stat(renderCompose);
      console.log(`Stopping ${app}...`);
      const downArgs = options.keepVolumes ? ["down"] : ["down", "-v"];
      dockerCompose(downArgs, renderCompose);
    } catch {
      // No rendered compose — app wasn't deployed
    }

    // Remove rendered output
    try {
      await rm(rendersDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }

    // Remove app definition
    await rm(appDir, { recursive: true, force: true });
    console.log(`Deleted app "${app}"`);

    if (!options.keepVolumes) {
      console.log("Volumes removed with docker compose down -v");
    } else {
      console.log("Volumes kept (use docker volume prune to clean up)");
    }
  });
