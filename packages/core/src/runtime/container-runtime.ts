/**
 * The single place appbay decides which container binary to invoke.
 *
 * WHY THIS EXISTS: `docker` was a string literal repeated across the codebase —
 * ~47 spawn sites in ~20 non-test files, with a partial helper
 * (`apps/cli/src/utils/docker.ts`) that most callers bypassed. Running appbay on
 * podman meant editing every one of them, and any site missed would silently
 * shell out to a binary that is not installed. Centralising is the fix; making
 * the choice CONFIGURED rather than detected is what stops it drifting back.
 *
 * ⚠️ THIS SELECTS A CLIENT BINARY, NOT A DAEMON, and the distinction is the
 * whole point. `docker` here can be driving a rootful `podman.socket` through
 * `DOCKER_HOST` — podman documents `docker-compose` as its PREFERRED compose
 * provider and wires the socket for it. So "we run podman" does NOT imply
 * container_runtime: podman. Set `podman` only when you want the podman binary
 * itself invoked; if you install the Docker CLI against podman's socket, leave
 * this as `docker` and point DOCKER_HOST at the socket.
 *
 * Resolution order, highest first:
 *   1. `$APPBAY_CONTAINER_RUNTIME`      — runtime override, for one invocation
 *   2. `container_runtime` in $APPBAY_HOME/project.yaml   — the configured value
 *   3. `docker`                          — default, preserves prior behaviour
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  parseInstanceConfig,
  ContainerRuntimeSchema,
  DEFAULT_CONTAINER_RUNTIME,
  IngressProviderSchema,
  AcmeDnsProviderSchema,
  type AcmeDnsProvider,
  DEFAULT_INGRESS_PROVIDER,
  type ContainerRuntime,
  type IngressProvider,
  type InstanceConfig,
} from "../schemas/instance.js";

// ⚠️ ContainerRuntime and DEFAULT_CONTAINER_RUNTIME are NOT re-exported here.
// Both barrels (schemas/index.ts and this file) are pulled into the package root
// with `export *`, and a name exported by two of them becomes ambiguous rather
// than merged. They belong to the schema; this module only consumes them.

/**
 * Cache keyed by resolved APPBAY_HOME.
 *
 * ⚠️ Keyed, not a single value. Tests and the server both switch homes within
 * one process; a scalar cache would leak one installation's runtime into
 * another's commands, which is the kind of bug that only shows up on the second
 * install and is then blamed on the first.
 */
const cache = new Map<string, InstanceConfig>();

/**
 * Read and cache the instance config for a home path.
 *
 * ⚠️ Caches the whole parsed config rather than one field. `ingress_provider` arrived
 * second; giving it its own map would have meant a second cache, a second clear
 * function, and two chances to forget one of them.
 */
function instanceConfig(appbayHome?: string): InstanceConfig {
  const home = appbayHome ?? defaultAppbayHome();
  const cached = cache.get(home);
  if (cached) return cached;

  let config: InstanceConfig = {};
  try {
    config = parseInstanceConfig(readFileSync(join(home, "project.yaml"), "utf-8"));
  } catch {
    // No project.yaml — an uninitialised install, or a command that runs before init.
    // Default rather than fail: `appbay doctor` must still be able to say what is missing.
  }

  cache.set(home, config);
  return config;
}

/**
 * Resolve APPBAY_HOME the way core already does elsewhere.
 *
 * ⚠️ Deliberately simpler than the CLI's `resolveAppbayHome`, which also consults
 * `~/.config/appbay/home`. Core cannot import from apps/cli, and duplicating the
 * saved-path lookup here would create a second resolver free to disagree with the
 * first. CLI callers should pass their resolved home explicitly; this fallback
 * exists for core-internal callers that have no home in hand.
 */
function defaultAppbayHome(): string {
  return process.env.APPBAY_HOME ?? join(homedir(), ".appbay");
}

/**
 * Which container runtime should this installation use?
 *
 * @param appbayHome - Installation root. Omit to resolve from the environment.
 */
export function resolveContainerRuntime(appbayHome?: string): ContainerRuntime {
  // 1. Env override always wins and is never cached — it is per-invocation by
  //    definition, and caching it would make the override sticky across a
  //    process that legitimately changes it.
  const fromEnv = process.env.APPBAY_CONTAINER_RUNTIME;
  if (fromEnv) {
    const parsed = ContainerRuntimeSchema.safeParse(fromEnv.trim());
    if (parsed.success) return parsed.data;
    // An unparseable override is a typo worth surfacing, not worth crashing on.
    console.warn(
      `[appbay] Ignoring APPBAY_CONTAINER_RUNTIME="${fromEnv}" — expected "docker" or "podman".`,
    );
  }

  return instanceConfig(appbayHome).container_runtime ?? DEFAULT_CONTAINER_RUNTIME;
}

/**
 * Which reverse proxy fronts this installation?
 *
 * Same resolution shape as the container runtime, deliberately — one mechanism to learn.
 * `$APPBAY_INGRESS_PROVIDER` overrides for a single invocation and is never cached.
 */
export function resolveIngressProvider(appbayHome?: string): IngressProvider {
  const fromEnv = process.env.APPBAY_INGRESS_PROVIDER;
  if (fromEnv) {
    const parsed = IngressProviderSchema.safeParse(fromEnv.trim());
    if (parsed.success) return parsed.data;
    console.warn(
      `[appbay] Ignoring APPBAY_INGRESS_PROVIDER="${fromEnv}" — expected "traefik" or "caddy".`,
    );
  }
  return instanceConfig(appbayHome).ingress_provider ?? DEFAULT_INGRESS_PROVIDER;
}

/**
 * Which DNS provider, if any, drives the ACME DNS-01 challenge here?
 *
 * ⚠️ `undefined` is the meaningful answer, not a missing one — it means this installation
 * does not use DNS-01, so Caddy falls back to HTTP-01 for public names and its INTERNAL
 * issuer for everything else. The internal issuer never errors, which is exactly why the
 * absence has to be readable rather than inferred.
 */
export function resolveAcmeDnsProvider(appbayHome?: string): AcmeDnsProvider | undefined {
  const fromEnv = process.env.APPBAY_ACME_DNS_PROVIDER;
  if (fromEnv) {
    const parsed = AcmeDnsProviderSchema.safeParse(fromEnv.trim());
    if (parsed.success) return parsed.data;
    console.warn(
      `[appbay] Ignoring APPBAY_ACME_DNS_PROVIDER="${fromEnv}" — expected "cloudflare".`,
    );
  }
  return instanceConfig(appbayHome).acme_dns_provider;
}

/**
 * The binary name to spawn.
 *
 * Use this instead of the literal "docker" at every spawn site.
 */
export function containerBin(appbayHome?: string): string {
  return resolveContainerRuntime(appbayHome);
}

/**
 * Drop cached resolutions.
 *
 * Call after `appbay init` writes a new runtime, and between tests. Without a
 * home argument it clears everything.
 */
export function clearContainerRuntimeCache(appbayHome?: string): void {
  if (appbayHome === undefined) cache.clear();
  else cache.delete(appbayHome);
}

// ---------------------------------------------------------------------------
// Runtime profiles — the ONLY place the two runtimes are allowed to differ
// ---------------------------------------------------------------------------

/**
 * The handful of facts that genuinely differ between Docker and Podman.
 *
 * 🚨 THIS TABLE IS THE WHOLE DIVERGENCE BUDGET. Measured against podman 6.0.2 and
 * docker 29.4.0 with both services running, every command appbay issues behaves
 * identically — `--version`, `compose version --short`, `ps --format`, `image ls`,
 * `network inspect`, `context inspect`. There is exactly ONE incompatible call, and
 * it is a template string, not a command:
 *
 *     docker info --format {{.ServerVersion}}     -> 29.4.0
 *     podman info --format {{.ServerVersion}}     -> Error: can't evaluate field
 *                                                   ServerVersion in system.infoReport
 *     podman info --format {{.Version.Version}}   -> 6.0.2
 *
 * ⇒ So the code stays unified and this table absorbs the difference. Resist adding
 * `if (runtime === "podman")` anywhere else: if a second real divergence turns up,
 * it belongs here as another field, not as a branch at the call site. Two parallel
 * implementations of a nearly-identical CLI is the outcome this exists to prevent.
 *
 * The display strings are here for the same reason — a doctor report that says
 * "Docker daemon not responding" while driving podman, and tells you to run
 * `systemctl start docker`, is worse than useless: it sends the operator to fix a
 * thing that is not installed.
 */
export interface RuntimeProfile {
  /** Human-readable name for reports and errors. */
  displayName: string;
  /** `info --format` template yielding the SERVICE version. The one real divergence. */
  serverVersionFormat: string;
  /** Where to get it, when it is missing. */
  installUrl: string;
  /** What to do when the service is not answering. */
  startHint: string;
}

const PROFILES: Record<ContainerRuntime, RuntimeProfile> = {
  docker: {
    displayName: "Docker",
    serverVersionFormat: "{{.ServerVersion}}",
    installUrl: "https://docs.docker.com/get-docker/",
    startHint:
      "Start Docker: systemctl start docker (Linux) or open Docker Desktop / OrbStack (macOS)",
  },
  podman: {
    displayName: "Podman",
    serverVersionFormat: "{{.Version.Version}}",
    installUrl: "https://podman.io/docs/installation",
    startHint:
      "Start Podman: systemctl --user start podman.socket (Linux) or podman machine start (macOS)",
  },
};

/** Profile for the configured runtime. */
export function runtimeProfile(appbayHome?: string): RuntimeProfile {
  return PROFILES[resolveContainerRuntime(appbayHome)];
}

/** Result of a container command invocation. */
export interface ContainerResult {
  /** Process exit code (0 = success). */
  exitCode: number;
  /** stdout on success, stderr or the spawn error message on failure. */
  output: string;
}

/** Options accepted by the container helpers. */
export interface ContainerExecOptions extends Omit<SpawnSyncOptions, "encoding"> {
  /** Installation root, so the runtime resolves against the right project.yaml. */
  appbayHome?: string;
  /**
   * What to call this invocation in the generic failure message.
   *
   * ⚠️ Exists because collapsing every invocation into one helper otherwise
   * DEGRADES the error text. A compose failure with empty stderr used to read
   * "docker compose exited with code 1"; without this it reads "docker exited
   * with code 1", and the operator no longer knows which of the dozen docker
   * calls in a deploy actually failed. Defaults to the binary name.
   */
  label?: string;
}

/**
 * Run the container binary with an explicit argument array.
 *
 * No shell, ever — arguments go straight to execve, so image names, volume paths
 * and label filters cannot inject regardless of content.
 */
export function containerExec(
  args: string[],
  options: ContainerExecOptions = {},
): ContainerResult {
  const { appbayHome, label, ...spawnOptions } = options;
  const bin = containerBin(appbayHome);
  const result = spawnSync(bin, args, {
    encoding: "utf-8",
    ...spawnOptions,
  });

  if (result.error) {
    return { exitCode: 1, output: result.error.message };
  }
  if (result.status !== 0) {
    return {
      exitCode: result.status ?? 1,
      output:
        (result.stderr as string | null) ||
        `${label ?? bin} exited with code ${String(result.status)}`,
    };
  }
  return { exitCode: 0, output: (result.stdout as string | null) ?? "" };
}

/**
 * Run a `compose` subcommand against a specific compose file.
 *
 * ⚠️ The argument shape is identical for both runtimes and that is not luck:
 * `podman compose` is a thin wrapper that hands off to an external provider
 * (docker-compose preferred) with `DOCKER_HOST` already pointed at the podman
 * socket. So `<bin> compose -f <file> …` is correct for docker and podman alike,
 * and no branch is needed here.
 *
 * @param args - Arguments after `<bin> compose -f <file>` (e.g. ["up", "-d"]).
 * @param composePath - Absolute path to the rendered compose file.
 * @param extraEnv - Extra environment for the child. The shepherd passes resolved
 *   secrets this way so they live only in the process env chain, never on disk.
 */
export function containerCompose(
  args: string[],
  composePath: string,
  extraEnv?: Record<string, string>,
  appbayHome?: string,
): ContainerResult {
  return containerExec(["compose", "-f", composePath, ...args], {
    appbayHome,
    label: `${containerBin(appbayHome)} compose`,
    timeout: 600_000,
    maxBuffer: 50 * 1024 * 1024,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
}

/**
 * The container service's version, or null when it is not answering.
 *
 * ⚠️ This is the one call that could not stay literal — see RuntimeProfile. Callers
 * asking "is the service up, and what is it" must come through here rather than
 * hand-writing `info --format {{.ServerVersion}}`, which silently fails on Podman
 * with a Go template error rather than a connection error, so the report reads
 * "daemon not responding" when the daemon is fine and only the template was wrong.
 */
export function containerServerVersion(appbayHome?: string): string | null {
  const { serverVersionFormat } = runtimeProfile(appbayHome);
  const result = containerExec(["info", "--format", serverVersionFormat], {
    appbayHome,
    timeout: 10_000,
  });
  if (result.exitCode !== 0) return null;
  const version = result.output.trim();
  return version || null;
}
