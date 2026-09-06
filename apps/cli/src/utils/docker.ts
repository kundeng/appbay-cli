/**
 * The CLI's compose wrapper and its running-app lookups, over core's runtime helpers with
 * the CLI-resolved home. The CLI's home resolver and core's read the same two pointer files
 * through the same parser, so no wrapper here exists to correct a difference between them.
 */

import {
  containerCompose,
  findContainerByLabel,
  APP_LABEL,
  type DockerComposeResult,
  type Inspection,
  type ContainerResult,
  type ContainerMatch,
} from "@appbay/core";
import { resolveAppbayHome } from "./appbay-home.js";


/**
 * Run a `docker compose` command against a specific compose file.
 *
 * @param args - Arguments after `docker compose -f <file>` (e.g., ["up", "-d"]).
 * @param composePath - Absolute path to the rendered compose file.
 * @param extraEnv - Additional environment variables to inject into the docker
 *   compose process. Used by the shepherd to pass resolved secrets — these
 *   exist only in the process env chain and never touch disk.
 */
export function dockerCompose(
  args: string[],
  composePath: string,
  extraEnv?: Record<string, string>,
): DockerComposeResult {
  // Delegates to core so the runtime decision lives in exactly one place. The
  // name and signature are kept because callers across the CLI import them; only
  // the body moved.
  return containerCompose(args, composePath, extraEnv, resolveAppbayHome());
}


/** The container running an installed app, found by its label; unknown when the runtime could not be asked. */
export function runningAppContainer(app: string): Promise<Inspection<ContainerMatch | null>> {
  return findContainerByLabel(APP_LABEL, app, { appbayHome: resolveAppbayHome() });
}

/**
 * The name of the running container for `app`, or exit 1 with the reason. "Not running"
 * and "could not ask the runtime" are different messages because they call for different
 * actions.
 */
export async function requireRunningApp(app: string): Promise<string> {
  const found = await runningAppContainer(app);
  if (found.kind === "unknown") {
    console.error(`Cannot reach the container runtime: ${found.reason}`);
    process.exit(1);
  }
  if (!found.value?.running) {
    console.error(`${app} container is not running. Start it with: appbay up ${app}`);
    process.exit(1);
  }
  return found.value.name;
}

/**
 * Exit with the child's code, and when the child never ran or was killed at its timeout,
 * say so: with `stdio: "inherit"` nothing else would.
 */
export function exitWithContainerResult(result: ContainerResult): never {
  if (result.failedToStart || result.timedOut) console.error(result.output.trim());
  process.exit(result.exitCode);
}
