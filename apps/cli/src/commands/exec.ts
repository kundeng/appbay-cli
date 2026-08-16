import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveAppbayHome } from "../utils/appbay-home.js";

export const execCommand = new Command("exec")
  .description("Execute a command in a running service container")
  .argument("<app>", "app name")
  .argument("[command...]", "command to execute (default: /bin/sh)")
  .action((app: string, command: string[]) => {
    const appbayHome = resolveAppbayHome();
    const composePath = join(appbayHome, "var", "lib", "renders", app, "docker-compose.rendered.yml");

    if (!existsSync(composePath)) {
      console.error(`App "${app}" has no rendered compose. Deploy it first with: appbay up ${app}`);
      process.exit(1);
    }

    const cmd = command.length > 0 ? command : ["/bin/sh"];
    const result = spawnSync(
      "docker",
      ["compose", "-f", composePath, "exec", app, ...cmd],
      { stdio: "inherit" },
    );

    process.exit(result.status ?? 1);
  });

export const shellCommand = new Command("shell")
  .description("Open an interactive shell in a running service container")
  .argument("<app>", "app name")
  .action((app: string) => {
    const appbayHome = resolveAppbayHome();
    const composePath = join(appbayHome, "var", "lib", "renders", app, "docker-compose.rendered.yml");

    if (!existsSync(composePath)) {
      console.error(`App "${app}" has no rendered compose. Deploy it first with: appbay up ${app}`);
      process.exit(1);
    }

    const result = spawnSync(
      "docker",
      ["compose", "-f", composePath, "exec", app, "/bin/sh"],
      { stdio: "inherit" },
    );

    process.exit(result.status ?? 1);
  });

export const runCommand = new Command("run")
  .description("Run a one-off command in a service container")
  .argument("<app>", "app name")
  .argument("[command...]", "command to run")
  .option("--rm", "remove container after exit (default: true)")
  .action((app: string, command: string[]) => {
    const appbayHome = resolveAppbayHome();
    const composePath = join(appbayHome, "var", "lib", "renders", app, "docker-compose.rendered.yml");

    if (!existsSync(composePath)) {
      console.error(`App "${app}" has no rendered compose. Deploy it first with: appbay up ${app}`);
      process.exit(1);
    }

    const cmd = command.length > 0 ? command : ["/bin/sh"];
    const result = spawnSync(
      "docker",
      ["compose", "-f", composePath, "run", "--rm", app, ...cmd],
      { stdio: "inherit" },
    );

    process.exit(result.status ?? 1);
  });
