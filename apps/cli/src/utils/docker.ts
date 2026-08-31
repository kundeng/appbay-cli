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

import { spawnSync } from "node:child_process";
import {
  containerBin,
  containerCompose,
  runtimeProfile,
  type RuntimeProfile,
} from "@appbay/core";
import { resolveAppbayHome } from "./appbay-home.js";

/**
 * The container binary for CLI invocations.
 *
 * ⚠️ Use THIS from CLI commands, never core's `containerBin()` directly. Core
 * resolves APPBAY_HOME from `$APPBAY_HOME` or `~/.appbay`; the CLI additionally
 * honours the path saved at `~/.config/appbay/home` by `appbay init`. A command
 * calling core's resolver directly would read the wrong project.yaml on any
 * install that chose a custom `--dir`, and would do it silently — the binary
 * name would just be the default.
 */
export function cliContainerBin(): string {
  return containerBin(resolveAppbayHome());
}

/** Result of a docker compose invocation. */
export interface DockerComposeResult {
  /** Process exit code (0 = success). */
  exitCode: number;
  /** Combined stdout/stderr output. */
  output: string;
}

/**
 * Run a `docker compose` command against a specific compose file.
 *
 * @param args - Arguments to pass after `docker compose -f <file>` (e.g., ["up", "-d"]).
 * @param composePath - Absolute path to the rendered compose file.
 * @returns Structured result with exit code and output.
 */
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
 * Same home-resolution reasoning as cliContainerBin(): the CLI honours
 * ~/.config/appbay/home, core does not, so CLI callers must come through here.
 */
export function cliRuntimeProfile(): RuntimeProfile {
  return runtimeProfile(resolveAppbayHome());
}
