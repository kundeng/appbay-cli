/**
 * `appbay logs [app] [service]` command.
 *
 * Streams Docker Compose logs for a specific app (and optionally a specific
 * service within that app). Uses the rendered compose file if available,
 * otherwise falls back to the source compose.
 *
 * Options:
 *   --follow, -f     follow log output in real-time
 *   --tail <n>       number of lines to show from the end (default: all)
 *
 * Exit codes:
 *   0 -- logs displayed successfully
 *   1 -- app not found or docker compose failed
 */

import { Command } from "commander";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { discoverApps } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { resolveComposeFile } from "../utils/paths.js";
import { cliContainerBin } from "../utils/docker.js";

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

    // Discover the target app.
    const discovered = await discoverApps({ appsDir });
    const target = discovered.find((a) => a.name === app);

    if (!target) {
      console.error(`App "${app}" not found in ${appsDir}`);
      process.exit(1);
    }

    const composeFile = await resolveComposeFile(app, target.composePath, rendersDir);

    // Build the docker compose logs command arguments.
    const args: string[] = ["compose", "-f", composeFile, "logs"];

    if (options.follow) {
      args.push("--follow");
    }

    if (options.tail) {
      args.push("--tail", options.tail);
    }

    if (service) {
      args.push(service);
    }

    // Spawn docker compose logs and stream output to the terminal.
    // Use "inherit" for all stdio so TypeScript keeps the ChildProcess return
    // type (explicit tuple literals narrow to ChildProcessByStdio<…> which
    // lacks .on()). Inheriting stdin for a read-only log stream is harmless.
    const child = spawn(cliContainerBin(), args, { stdio: "inherit" });

    child.on("close", (code) => {
      process.exit(code ?? 0);
    });

    child.on("error", (err) => {
      console.error(`Failed to run docker compose logs: ${err.message}`);
      process.exit(1);
    });
  });
