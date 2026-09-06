/**
 * `appbay logs [app] [service] [--follow] [--tail <n>]`: `compose logs` against the app's
 * rendered file (its source compose when no render exists), streamed to the terminal.
 *
 * Exit codes: compose's own; 1 when the app is not found.
 */

import { Command } from "commander";
import { join } from "node:path";
import { discoverApps, containerSpawn } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { resolveComposeFile } from "../utils/paths.js";

export const logsCommand = new Command("logs")
  .description("Show logs for an app or service")
  .argument("[app]", "app name")
  .argument("[service]", "specific service within the app")
  .option("-f, --follow", "follow log output")
  .option("--tail <n>", "number of lines to show from the end")
  .action(async (app: string | undefined, service: string | undefined, options: { follow?: boolean; tail?: string }) => {
    if (!app) {
      console.error("Usage: appbay logs <app> [service] [--follow] [--tail <n>]");
      process.exit(1);
    }

    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");
    const rendersDir = join(appbayHome, "var", "lib", "renders");

    const target = (await discoverApps({ appsDir })).find((a) => a.name === app);
    if (!target) {
      console.error(`App "${app}" not found in ${appsDir}`);
      process.exit(1);
    }

    const composeFile = await resolveComposeFile(app, target.composePath, rendersDir);
    const args = ["compose", "-f", composeFile, "logs"];
    if (options.follow) args.push("--follow");
    if (options.tail) args.push("--tail", options.tail);
    if (service) args.push(service);

    // stdio inherited on all three: a read-only stream with the terminal's stdin is harmless,
    // and the plain form keeps the ChildProcess type that carries `.on()`.
    const child = containerSpawn(args, { appbayHome, stdio: "inherit" });
    child.on("close", (code) => process.exit(code ?? 0));
    child.on("error", (err) => {
      console.error(`Failed to run compose logs: ${err.message}`);
      process.exit(1);
    });
  });
