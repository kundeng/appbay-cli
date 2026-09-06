/**
 * `appbay delete <app>` — remove an app definition.
 */
import { Command } from "commander";
import { composeProject, engineObserver, discoverApps } from "@appbay/core";
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

    // The name is resolved through discovery, never used as a path: `delete .. --force` once
    // removed etc/ and var/lib/ (S48 round 10). The app directory is the one discovery found.
    const installed = await discoverApps({ appsDir });
    const target = installed.find((a) => a.name === app);
    if (!target) {
      console.error(`  [${app}] target: no installed app named "${app}"`);
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
    let stopped = false;
    const renderCompose = join(rendersDir, "docker-compose.rendered.yml");
    try {
      await stat(renderCompose);
      console.log(`Stopping ${app}...`);
      const downArgs = options.keepVolumes ? ["down"] : ["down", "-v"];
      // The project is stated (S48 round 7); a down that failed leaves containers a deleted
      // render can no longer reach, so the deletion stops here.
      const down = dockerCompose(["-p", composeProject(app), ...downArgs], renderCompose);
      if (down.exitCode !== 0) {
        console.error(`Could not stop ${app}; nothing was deleted. ${down.output.trim()}`);
        process.exit(1);
      }
      stopped = true;
    } catch {
      // No render. If the project still has containers, deleting the definition would leave
      // them with nothing that reaches them; `up` re-renders, then `down` stops this install's.
      const rows = await engineObserver(resolveAppbayHome()).project(app);
      if (rows.kind === "unknown") {
        console.error(`Could not ask the runtime whether ${app} runs (${rows.reason}); nothing was deleted.`);
        process.exit(1);
      }
      if (rows.value.length > 0) {
        console.error(`${app} has running containers and no render; run: appbay up ${app}, then appbay down ${app}, then delete it.`);
        process.exit(1);
      }
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

    if (!stopped) {
      console.log("Nothing was running, so no volumes were touched.");
    } else if (!options.keepVolumes) {
      console.log("Volumes removed with compose down -v");
    } else {
      console.log("Volumes kept (remove them by hand when no longer needed)");
    }
  });
