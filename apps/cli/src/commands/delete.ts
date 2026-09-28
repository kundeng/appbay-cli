/**
 * `appbay delete <app>` — remove an app definition.
 */
import { Command } from "commander";
import { composeProject, engineObserver, discoverApps } from "@appbay/core";
import { projectOwnershipError, resolveAppbayHome, resolveAppsDir } from "../utils/appbay-home.js";
import { basename, dirname, join, relative } from "node:path";
import { realpath, rm, stat } from "node:fs/promises";
import { dockerCompose } from "../utils/docker.js";

export const deleteCommand = new Command("delete")
  .description("Delete an app definition")
  .argument("<app>", "app to delete")
  .option("--keep-volumes", "keep Docker volumes")
  .option("--force", "skip confirmation")
  .action(async (app: string, options: { keepVolumes?: boolean; force?: boolean }) => {
    const home = resolveAppbayHome();
    const appsDir = resolveAppsDir();
    const installed = await discoverApps({ appsDir });
    const target = installed.find((a) => a.name === app);
    if (!target) {
      console.error(`  [${app}] target: no installed app named "${app}"`);
      process.exit(1);
    }

    const appsRoot = await realpath(appsDir);
    const appDir = dirname(await realpath(target.composePath));
    const targetName = basename(appDir);
    const fromRoot = relative(appsRoot, appDir);
    if (fromRoot !== target.name) {
      console.error(`${app}: discovered app does not resolve to its direct directory under the apps root; nothing was deleted.`);
      process.exit(1);
    }
    const rendersDir = join(home, "var/lib/renders", targetName);

    if (!options.force) {
      console.log(`This will delete the app definition at ${appDir}`);
      console.log(`Volumes will be ${options.keepVolumes ? "kept" : "removed"}.`);
      console.log(`Use --force to skip this confirmation.\n`);
      // In a real implementation, prompt for confirmation
      // For now, require --force
      console.error("Use --force to confirm deletion.");
      process.exit(1);
    }

    // Observe before any project-wide down, including when a render exists.
    const rows = await engineObserver(home).project(targetName);
    if (rows.kind === "unknown") {
      console.error(`Could not ask the runtime whether ${app} is owned here (${rows.reason}); nothing was deleted.`);
      process.exit(1);
    }
    let renderExists = false;
    const renderCompose = join(rendersDir, "docker-compose.rendered.yml");
    try {
      renderExists = (await stat(renderCompose)).isFile();
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
    }

    let stopped = false;
    const willRunCompose = renderExists || rows.value.some((row) => row.state === "running");
    if (willRunCompose) {
      // Compose down removes every container in the project, including exited rows. The
      // mutation is safe only when all of them came from this Appbay home.
      const ownershipError = projectOwnershipError(home, rows.value);
      if (ownershipError) {
        console.error(`${app}: project is not owned by this Appbay home: ${ownershipError}; nothing was deleted.`);
        process.exit(1);
      }
      console.log(`Stopping ${targetName}...`);
      const downArgs = options.keepVolumes ? ["down"] : ["down", "-v"];
      const down = dockerCompose(["-p", composeProject(targetName), ...downArgs], renderExists ? renderCompose : target.composePath);
      if (down.exitCode !== 0) {
        console.error(`Could not stop ${app}; nothing was deleted. ${down.output.trim()}`);
        process.exit(1);
      }
      stopped = true;
    }

    // Remove rendered output
    try {
      await rm(rendersDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }

    // Remove app definition
    await rm(appDir, { recursive: true, force: true });
    console.log(`Deleted app "${targetName}"`);

    if (!stopped) {
      console.log("Nothing was running, so no volumes were touched.");
    } else if (!options.keepVolumes) {
      console.log("Volumes removed with compose down -v");
    } else {
      console.log("Volumes kept (remove them by hand when no longer needed)");
    }
  });
