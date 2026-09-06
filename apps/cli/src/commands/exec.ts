/**
 * `appbay exec|shell|run <app> [command...]`: a command inside the app's service container,
 * through `compose exec` or `compose run --rm` against the rendered file. The container
 * binary is chosen in `runtime/`; this file only builds the argument list.
 */
import { Command } from "commander";
import { exitWithContainerResult } from "../utils/docker.js";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { containerExec, SHARED_NETWORK, composeProject } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";

function renderedComposeOrExit(appbayHome: string, app: string): string {
  const composePath = join(appbayHome, "var", "lib", "renders", app, "docker-compose.rendered.yml");
  if (!existsSync(composePath)) {
    console.error(`App "${app}" has no rendered compose. Deploy it first with: appbay up ${app}`);
    process.exit(1);
  }
  return composePath;
}

/**
 * The compose service to address: the render keeps the upstream's service names, which are
 * not the app's name. The service on the shared network (the one the edge routes to) wins;
 * a single-service render needs no choice; otherwise the app name is the last guess.
 */
function serviceOf(composePath: string, app: string): string {
  try {
    const compose = parseYaml(readFileSync(composePath, "utf-8")) as { services?: Record<string, { networks?: Record<string, unknown> }> };
    const names = Object.keys(compose.services ?? {});
    if (names.includes(app)) return app;
    const shared = names.find((n) => compose.services?.[n]?.networks && SHARED_NETWORK in (compose.services[n]!.networks ?? {}));
    return shared ?? (names.length === 1 ? names[0]! : app);
  } catch {
    return app;
  }
}

function composeInteractive(verb: "exec" | "run", app: string, command: string[]): never {
  const appbayHome = resolveAppbayHome();
  const composePath = renderedComposeOrExit(appbayHome, app);
  const cmd = command.length > 0 ? command : ["/bin/sh"];
  const extra = verb === "run" ? ["--rm"] : [];
  const result = containerExec(["compose", "-f", composePath, "-p", composeProject(app), verb, ...extra, serviceOf(composePath, app), ...cmd], { appbayHome, stdio: "inherit" });
  exitWithContainerResult(result);
}

export const execCommand = new Command("exec")
  .description("Execute a command in a running service container")
  .argument("<app>", "app name")
  .argument("[command...]", "command to execute (default: /bin/sh)")
  .action((app: string, command: string[]) => composeInteractive("exec", app, command));

export const shellCommand = new Command("shell")
  .description("Open an interactive shell in a running service container")
  .argument("<app>", "app name")
  .action((app: string) => composeInteractive("exec", app, []));

export const runCommand = new Command("run")
  .description("Run a one-off command in a service container")
  .argument("<app>", "app name")
  .argument("[command...]", "command to run")
  .option("--rm", "remove container after exit (default: true)")
  .action((app: string, command: string[]) => composeInteractive("run", app, command));
