/**
 * Docker Compose execution helper and runtime discovery utilities.
 *
 * Uses child_process.spawnSync with explicit argument arrays (no shell) to
 * invoke `docker compose` — this avoids shell injection regardless of what
 * composePath or args contain. Returns a structured result with exit code and
 * output so callers can handle errors without try/catch boilerplate.
 *
 * ⚠️ This file used to export discoverRunningApps(). RFC-001 §5 made `when:` mean
 * *installed* — a fact about the declared app set — so the compiler stopped asking the
 * runtime which apps were up, and the CLI has no other feature that reports running state.
 * Removed rather than kept: the CLI's copy had zero callers and ten tests, which is exactly
 * what dead code that looks alive looks like. `apps/web` keeps its own copy, which does have
 * callers — the running/stopped indicator.
 */

import {
  containerBin,
  containerCompose,
  runtimeProfile,
  findContainerByLabel,
  APP_LABEL,
  type RuntimeProfile,
  type DockerComposeResult,
  type Inspection,
  type ContainerMatch,
} from "@appbay/core";
import { resolveAppbayHome } from "./appbay-home.js";

/**
 * The container binary for CLI invocations.
 *
 * CLI commands call this rather than core's `containerBin()` with no argument. Core's
 * `resolveHome` reads `$APPBAY_HOME`, the host pointer and the user pointer; the CLI's
 * `resolveAppbayHome` consults the CLI-side system config as well (`utils/system-config.ts`),
 * so the home the two derive can differ on a host `init-system` set up. The wrapper passes
 * the CLI's answer down; a command that let core default the home could read the wrong
 * instance config silently.
 */
export function cliContainerBin(): string {
  return containerBin(resolveAppbayHome());
}

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

/**
 * Runtime profile for CLI reporting — display name, install URL, start hint, and the
 * one `info --format` template that differs between runtimes.
 *
 * Same home-resolution reasoning as cliContainerBin(): the CLI's home resolver consults the
 * CLI-side system config as well as core's tiers, so CLI callers come through here.
 */
export function cliRuntimeProfile(): RuntimeProfile {
  return runtimeProfile(resolveAppbayHome());
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
