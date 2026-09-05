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
import { join } from "node:path";
import {
  loadInstanceConfig,
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
import { podmanRootfulEnv } from "./podman-rootful.js";
import { resolveHome } from "./home.js";

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

  // Absent and unreadable both default here: `appbay doctor` must run before init and say
  // what is missing. The loader keeps the two apart for callers that need to know.
  const config = loadInstanceConfig(home).config;
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
  return resolveHome();
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
  /**
   * `info --format` template yielding the STORE ROOT — the directory holding this
   * service's images, volumes and networks.
   *
   * 🚨 THE SECOND REAL DIVERGENCE, and it arrived exactly as this table predicted:
   * as another field, not as a branch. Measured 2026-08-18:
   *
   *   podman info {{.Store.GraphRoot}}  rootful  -> /var/lib/containers/storage
   *                                     rootless -> /home/<u>/.local/share/containers/storage
   *   docker info {{.DockerRootDir}}             -> /var/lib/docker
   *   docker info {{.Store.GraphRoot}}           -> (empty — docker has no such field)
   *
   * The store root, not the socket path, is the right identity: it is where
   * `appbay_shared` and every named volume actually live, so two sockets sharing
   * one store are the same store and must not be reported as a mismatch.
   */
  storeRootFormat: string;
  /** Where to get it, when it is missing. */
  installUrl: string;
  /** What to do when the service is not answering. */
  startHint: string;
  /**
   * How to re-run a command against the OTHER store on this runtime.
   *
   * Part of the profile because the remediation differs: podman's rootful store is
   * reached with `sudo`, while a docker store mismatch means a different
   * `DOCKER_HOST`/context, and telling a docker user to "try sudo" sends them nowhere.
   */
  otherStoreHint: string;
  /** Matches the runtime's `--version` line and captures the version. */
  versionPattern: RegExp;
  /** Whether `compose` ships with the runtime, or is a separate provider to install. */
  composeBundled: boolean;
  /** The systemd unit that makes the API socket available on a service install. */
  systemdUnit: string;
  /** Environment a service account needs to reach this runtime's rootful store. Empty on Docker. */
  serviceAccountEnv: (appbayHome: string) => Record<string, string>;
  /**
   * How a service account is granted the API socket: Docker has a unix group with that
   * meaning; rootful Podman has none, so the group is created on the socket by a systemd
   * drop-in plus a tmpfiles override for its directory (S34, probe-89).
   */
  serviceAccountGrant: "unix-group" | "socket-dropin";
  /** RHEL-family install plan: dnf packages, and whether a vendor repo must be added first. */
  rhel: { label: string; packages: string[]; needsVendorRepo: boolean; composePackages: string[] };
}

const PROFILES: Record<ContainerRuntime, RuntimeProfile> = {
  docker: {
    displayName: "Docker",
    serverVersionFormat: "{{.ServerVersion}}",
    storeRootFormat: "{{.DockerRootDir}}",
    installUrl: "https://docs.docker.com/get-docker/",
    startHint:
      "Start Docker: systemctl start docker (Linux) or open Docker Desktop / OrbStack (macOS)",
    otherStoreHint:
      "Check DOCKER_HOST and `docker context ls` — this shell is pointed at a different daemon",
    versionPattern: /Docker version ([0-9]+\.[0-9]+\.[0-9]+)/,
    composeBundled: true,
    systemdUnit: "docker",
    serviceAccountEnv: () => ({}),
    serviceAccountGrant: "unix-group",
    rhel: {
      label: "Docker Engine",
      packages: ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"],
      needsVendorRepo: true,
      composePackages: [],
    },
  },
  podman: {
    displayName: "Podman",
    serverVersionFormat: "{{.Version.Version}}",
    storeRootFormat: "{{.Store.GraphRoot}}",
    installUrl: "https://podman.io/docs/installation",
    startHint:
      "Start Podman: systemctl --user start podman.socket (Linux) or podman machine start (macOS)",
    otherStoreHint:
      "Rootful and rootless podman keep SEPARATE stores. Re-run with `sudo` for the rootful one, or without it for your own",
    versionPattern: /podman version ([0-9]+\.[0-9]+\.[0-9]+)/,
    composeBundled: false,
    // Podman is daemonless; the rootful API socket unit is what a service install needs.
    systemdUnit: "podman.socket",
    serviceAccountEnv: podmanRootfulEnv,
    serviceAccountGrant: "socket-dropin",
    rhel: {
      label: "Podman",
      packages: ["podman", "podman-compose"],
      needsVendorRepo: false,
      composePackages: ["podman-compose"],
    },
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

/** The raw version lines the runtime and its compose provider print; null where a command failed. */
export function versions(appbayHome?: string): { runtime: string | null; compose: string | null; composeLong: string | null } {
  const bin = containerBin(appbayHome);
  return {
    runtime: tryExec(bin, ["--version"]),
    compose: tryExec(bin, ["compose", "version", "--short"]),
    composeLong: tryExec(bin, ["compose", "version"]),
  };
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

/**
 * The store root this invocation is talking to, or null when unavailable.
 *
 * 🚨 THIS IS THE FACT THAT WAS MISSING FROM DISK (#58 R3). `appbay init` as an
 * ordinary user on a host with an ACTIVE ROOTFUL SOCKET succeeded quietly against
 * that user's ROOTLESS store, creating `appbay_shared` where a rootful deploy
 * cannot see it. The operator met `External network [appbay_shared] does not
 * exists` much later, with nothing connecting it back to the choice made at init.
 *
 * Nothing recorded which store an install was bound to, so nothing could warn on a
 * switch either — and on a homelab box the switch is not exotic, it is
 * `appbay init` followed by `sudo appbay up`.
 *
 * Returns null rather than throwing when the service is not answering: "cannot
 * reach the runtime" is `runtime-access`'s verdict to give, and a store check that
 * also fails there would report the same outage twice under a misleading name.
 */
export function containerStoreRoot(appbayHome?: string): string | null {
  const { storeRootFormat } = runtimeProfile(appbayHome);
  const result = containerExec(["info", "--format", storeRootFormat], {
    appbayHome,
    timeout: 10_000,
  });
  if (result.exitCode !== 0) return null;
  const root = result.output.trim();
  return root || null;
}

/**
 * Run a binary and return its trimmed stdout, or null when it failed, timed out, or printed
 * nothing. The three callers that had their own copy all read null as "not available";
 * a check that must tell "empty" from "failed" uses `containerExec` instead.
 */
export function tryExec(binary: string, args: string[], options: { timeoutMs?: number } = {}): string | null {
  const result = spawnSync(binary, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });
  if (result.status !== 0 || result.error) return null;
  return (result.stdout as string).trim() || null;
}

// ---------------------------------------------------------------------------
// Observation results
// ---------------------------------------------------------------------------

/**
 * The answer to a question asked of the runtime: a value, or the reason none could be
 * obtained. `unknown` is not a negative verdict and a caller may not treat it as one.
 */
export type Inspection<T> =
  | { kind: "ok"; value: T }
  | { kind: "unknown"; reason: string };

function ok<T>(value: T): Inspection<T> {
  return { kind: "ok", value };
}

function unknown<T = never>(reason: string): Inspection<T> {
  return { kind: "unknown", reason };
}

/** One container the runtime reported for a label query. */
export interface ContainerMatch {
  name: string;
  /** The runtime's own state word, lower-cased: running, exited, created, restarting, … */
  state: string;
  running: boolean;
}

/** Runs the container binary with the given arguments. Injectable so parsing is testable. */
export type ContainerRunner = (args: string[]) => ContainerResult;

/**
 * Find the container carrying `label=value`, on either runtime.
 *
 * Asks `ps -a --filter label=<label>=<value>` so a stopped container is still found, and
 * reports it as not running. Two running matches is an ambiguity, returned as `unknown`
 * naming both, never a silent pick.
 */
export function findContainerByLabel(
  label: string,
  value: string,
  options: { appbayHome?: string; run?: ContainerRunner; labels?: Record<string, string> } = {},
): Inspection<ContainerMatch | null> {
  const run = options.run ?? ((args) => containerExec(args, { appbayHome: options.appbayHome, label: "ps" }));
  const filters = [`label=${label}=${value}`, ...Object.entries(options.labels ?? {}).map(([k, v]) => `label=${k}=${v}`)];
  const result = run(["ps", "-a", ...filters.flatMap((f) => ["--filter", f]), "--format", "{{.Names}}\t{{.State}}"]);
  if (result.exitCode !== 0) return unknown(result.output.trim() || `ps exited with code ${String(result.exitCode)}`);

  const matches: ContainerMatch[] = [];
  for (const line of result.output.split("\n")) {
    const [name, state = ""] = line.trim().split("\t");
    if (!name) continue;
    const s = state.trim().toLowerCase();
    matches.push({ name, state: s, running: s === "running" });
  }
  if (matches.length === 0) return ok(null);

  const running = matches.filter((m) => m.running);
  if (running.length > 1) {
    return unknown(`${running.length} running containers carry ${label}=${value}: ${running.map((m) => m.name).join(", ")}`);
  }
  return ok(running[0] ?? matches[0]);
}
