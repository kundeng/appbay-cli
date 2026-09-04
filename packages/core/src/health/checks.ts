/**
 * Prerequisite and health checks — THE ONE IMPLEMENTATION.
 *
 * 🚨 THERE USED TO BE TWO. `apps/cli/src/utils/checks.ts` and
 * `apps/web/src/server/routers/doctor.ts` each had their own check logic, their own
 * `tryExec`, and their own result shape. They drifted exactly as you would expect: the web
 * copy never received S23's runtime awareness, so on a Podman install it reported
 * "Docker daemon is not reachable" ON A HEALTHY HOST and told the operator to install
 * Docker. It also had no shared-network DNS check and no `fix` string on any result, which
 * made S22 Requirement 20.2 unimplementable. See issue #71.
 *
 * ⭐ EVERY CHECK TAKES `appbayHome` EXPLICITLY. Core deliberately has no equivalent of the
 * CLI's `resolveAppbayHome`, which also consults `~/.config/appbay/home`; duplicating that
 * lookup here would create a second resolver free to disagree with the first — the same
 * mistake one level down. Callers pass what they resolved.
 */

import { stat } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  containerBin,
  runtimeProfile,
  containerServerVersion,
  containerStoreRoot,
  resolveIngressProvider,
} from "../runtime/container-runtime.js";
import { podmanRootfulEnv } from "../runtime/podman-rootful.js";
import { parseInstanceConfig } from "../schemas/instance.js";
import { readInstanceConfigText } from "../schemas/instance.js";

/**
 * Try to execute a binary. Returns trimmed stdout on success, null on failure.
 */
export function tryExec(binary: string, args: string[]): string | null {
  const result = spawnSync(binary, args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  if (result.status !== 0 || result.error) return null;
  return (result.stdout as string).trim() || null;
}

/**
 * Compare two semver strings (e.g., "1.2.3" vs "v1.3.0").
 * Strips leading "v" prefix. Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}



/** Minimum required Docker Compose version. */
export const MIN_COMPOSE_VERSION = "2.23.1";

/**
 * Minimum version PER COMPOSE PROVIDER.
 *
 * 🚨 A SINGLE MINIMUM IS NOT EXPRESSIBLE, and assuming one made `appbay doctor` fail a
 * REQUIRED check that the recommended provider can never pass. podman-compose has its own
 * version line with no relation to Docker Compose's, so comparing it against 2.23.1 reads:
 *     ✗ Compose >= 2.23.1
 *       v1.5.0 (too old)
 * on a host where compose works perfectly. podman-compose will never reach 2.x, so on
 * RHEL-family — the runtime target S23 designates for Podman — that check failed forever.
 *
 * ⚠️ The key is the PROVIDER, not the runtime. Podman can drive either provider (its
 * `compose` verb hands off to an external one), so branching on the configured runtime
 * would still be wrong; S23's rule against `if (runtime === "podman")` holds here too.
 *
 * ⭐ THE FLOOR IS MEASURED WITH APPBAY'S OWN COMPOSE OUTPUT — not a hand-written file, and
 * certainly not a version banner. Measured:
 *     podman-compose 1.5.0 + rootful podman 5.6.2 (Fedora 43) -> `appbay up whoami` works
 *     podman-compose 1.0.6 + rootful podman 4.9.3 (Ubuntu)    -> CRASHES on appbay output
 *     docker compose v2.40.3                                   -> works
 *
 * 🚨 1.0.6 IS EXCLUDED FOR A SPECIFIC, REPRODUCIBLE REASON. AppBay emits the LONG-FORM
 * `env_file` from Compose Spec v2.24+:
 *     env_file:
 *       - path: /…/.env
 *         required: false
 * podman-compose 1.0.6 predates it and dies in container_to_args:
 *     i = os.path.realpath(os.path.join(dirname, i))
 *     TypeError: join() argument must be str, bytes, or os.PathLike object, not 'dict'
 * The `required: false` flag is what lets an app ship without a .env, so the long form is
 * not decoration.
 *
 * ⚠️ THIS FLOOR WAS BRIEFLY LOWERED TO 1.0.6 AND THAT WAS WRONG. The evidence for it was a
 * hand-written two-line compose that 1.0.6 handled fine — which proves the provider runs,
 * not that it runs OUR output. This repo's own warning says a version banner is not proof
 * compose works; the same applies one level up. Validate a provider with the compose AppBay
 * actually generates, or the measurement is about a file nobody deploys.
 */
export const COMPOSE_PROVIDER_MINIMUMS: Record<string, string> = {
  "docker-compose": MIN_COMPOSE_VERSION,
  "podman-compose": "1.5.0",
};

/** A compose provider and its version, as reported by `<bin> compose version`. */
export interface ComposeProvider {
  /** "docker-compose" | "podman-compose" */
  name: string;
  version: string;
  /** The minimum this provider must meet. */
  minimum: string;
}

/**
 * Identify the compose provider from the LONG `<bin> compose version` output.
 *
 * Podman prints its own version and the provider's, in that order:
 *     podman version 5.6.2
 *     podman-compose version 1.5.0
 * so a naive "first version number wins" parse picks up the RUNTIME version and compares
 * that against a compose minimum. Match the provider line explicitly instead.
 *
 * Returns null when no provider line is recognised; callers fall back to `--short`.
 */
export function parseComposeProvider(output: string): ComposeProvider | null {
  const podman = /podman-compose\s+version\s+v?(\d[\w.-]*)/i.exec(output);
  if (podman) {
    return { name: "podman-compose", version: podman[1], minimum: COMPOSE_PROVIDER_MINIMUMS["podman-compose"] };
  }
  const docker = /Docker\s+Compose\s+version\s+v?(\d[\w.-]*)/i.exec(output);
  if (docker) {
    return { name: "docker-compose", version: docker[1], minimum: COMPOSE_PROVIDER_MINIMUMS["docker-compose"] };
  }
  return null;
}

/** Container name for the server. */
export const SERVER_CONTAINER = "appbay.server";

/** Docker network name used by all appbay apps. */
export const SHARED_NETWORK = "appbay_shared";

/** Result of a single check. */
/**
 * ⚠️ NAMED `HealthCheckResult`, not `HealthCheckResult`. `@appbay/core` already exports a
 * `HealthCheckResult` from the secrets module for an unrelated concept, and two identically-named
 * types on one barrel is how a caller ends up importing the wrong one and finding out at
 * runtime. The CLI aliases this back to `HealthCheckResult` for its own consumers.
 */
/**
 * Stable identity for a check, independent of its human-readable name.
 *
 * ⚠️ `name` IS PROSE AND IS NOT A KEY. It is runtime-dependent ("docker-compose" vs
 * "podman-compose") and sometimes interpolated (`Compose >= ${MIN_COMPOSE_VERSION}`), so any
 * consumer that switches on it silently stops matching the moment a name is reworded or the
 * host changes runtime. The web Doctor screen did exactly that — its runtime fact cards
 * matched `"Docker"`, `"Docker Compose"`, `"Disk Space"` and `"GPU"`, none of which are
 * names this module has ever produced, so the whole card grid rendered as nothing with no
 * error anywhere. Switch on `id`.
 */
export type HealthCheckId =
  | "platform"
  | "runtime"
  | "runtime-access"
  | "service-account-runtime-access"
  | "store-binding"
  | "compose"
  | "compose-version"
  | "appbay-home"
  | "network"
  | "network-dns"
  | "healthcheck-start-period"
  | "traefik-config"
  | "caddy-security-config"
  | "vault"
  | "keepass-db"
  | "keepass-cli"
  | "server"
  | "gpu"
  | "sops";

/** A check result carrying its stable id — what `runChecks` returns. */
export type IdentifiedHealthCheck = HealthCheckResult & { id: HealthCheckId };

export interface HealthCheckResult {
  name: string;
  passed: boolean;
  detail: string;
  fix?: string;
  /** Whether this check is required for Appbay to function. */
  required: boolean;
}

/**
 * Check if the container runtime is installed and reachable.
 *
 * This only checks the BINARY is on PATH (`<bin> --version`) — it does not
 * touch the daemon. Whether the current user can actually reach the daemon is
 * `checkDockerAccessible`'s job. Keeping them separate is the mental model:
 * "is it installed?" vs "can I use it without sudo?"
 */
export function checkDocker(appbayHome: string): HealthCheckResult {
  // ⚠️ One code path, runtime-correct nouns. A report that says "Docker not found"
  // while appbay is configured for Podman sends the operator to install the wrong
  // thing — and the name is the ONLY part that differs, so it comes from the profile
  // rather than from a second branch.
  const { displayName, installUrl } = runtimeProfile(appbayHome);
  const version = tryExec(containerBin(appbayHome), ["--version"]);
  if (version) {
    return { name: displayName, passed: true, detail: version, required: true };
  }
  return {
    name: displayName,
    passed: false,
    detail: `${displayName} not found`,
    fix: `Install ${displayName}: ${installUrl}  (or run "appbay init-system" on a RHEL-family host to install it)`,
    required: true,
  };
}

/**
 * Is this invocation talking to the store the installation was created against?
 *
 * 🚨 #58 R3. `container_runtime: podman` matching is not enough — rootful and
 * rootless podman are two SEPARATE stores, and an install bound to one is invisible
 * from the other. The symptom used to arrive far downstream and misattributed:
 *
 *     ERROR: External network [appbay_shared] does not exists
 *
 * with nothing tying it back to whether `init` was run under sudo. On a homelab box
 * that switch is the normal path, not an exotic one: `appbay init` as yourself, then
 * `sudo appbay up` because the rootful socket is the one the server needs.
 *
 * ⭐ THREE OUTCOMES, and the third is the one that keeps this honest:
 *
 *   recorded == live    pass
 *   recorded != live    FAIL, required — refuse before anything is deployed
 *   nothing recorded    PASS, and say so — an install predating the key was never
 *                       asked the question, and failing it closed would break every
 *                       existing homelab on upgrade to prove a point about a
 *                       situation that may not even apply.
 *
 * The unreachable-runtime case returns a PASS too, deliberately: `runtime-access`
 * owns that verdict, and reporting one outage under two names sends the operator
 * looking for a second fault that does not exist.
 */
export function checkStoreBinding(appbayHome: string): HealthCheckResult {
  const name = "store binding";
  const { displayName, otherStoreHint } = runtimeProfile(appbayHome);

  let recorded: string | undefined;
  try {
    recorded = parseInstanceConfig(
      readInstanceConfigText(appbayHome, (p) => readFileSync(p, "utf-8")) ?? "",
    ).container_store;
  } catch {
    // No project.yaml at all — an uninitialised install. `appbay-home` reports that.
  }

  if (!recorded) {
    return {
      name,
      passed: true,
      detail: "not recorded (install predates the key) — run `appbay init` to record it",
      required: true,
    };
  }

  const live = containerStoreRoot(appbayHome);
  if (!live) {
    return {
      name,
      passed: true,
      detail: `recorded ${recorded}; runtime not answering — see runtime-access`,
      required: true,
    };
  }

  if (live === recorded) {
    return { name, passed: true, detail: recorded, required: true };
  }

  return {
    name,
    passed: false,
    detail: `bound to ${recorded}, but this shell reaches ${live}`,
    fix:
      `This install's networks and volumes live in ${recorded}. ${otherStoreHint}. ` +
      `To rebind it to the store you are on now, re-run \`appbay init\` — ` +
      `${displayName} will not move the existing ones for you.`,
    required: true,
  };
}

/**
 * Check if Compose v2 is installed.
 */
export function checkComposeInstalled(appbayHome: string): HealthCheckResult {
  // `<bin> compose` is the SAME command on both runtimes — podman ships a thin
  // wrapper that hands off to an external provider (docker-compose preferred) with
  // DOCKER_HOST already pointed at its socket. Measured working on podman 6.0.2.
  // So only the label changes; the check does not fork.
  const { displayName } = runtimeProfile(appbayHome);
  const label = `${displayName} Compose v2`;
  const version = tryExec(containerBin(appbayHome), ["compose", "version", "--short"]);
  if (version) {
    return { name: label, passed: true, detail: `v${version}`, required: true };
  }
  return {
    name: label,
    passed: false,
    detail: `${label} not found`,
    fix: "Install Docker Compose v2: https://docs.docker.com/compose/install/ (podman uses it as its compose provider too)",
    required: true,
  };
}

/**
 * Check if Compose version meets the minimum requirement.
 */
export function checkComposeVersion(appbayHome: string): HealthCheckResult {
  // Prefer the LONG output: it names the provider, which is what decides the minimum.
  const long = tryExec(containerBin(appbayHome), ["compose", "version"]);
  const provider = long ? parseComposeProvider(long) : null;
  if (provider) {
    const label = `${provider.name} >= ${provider.minimum}`;
    const clean = provider.version.replace(/^v/, "");
    if (compareSemver(clean, provider.minimum) >= 0) {
      return { name: label, passed: true, detail: `v${clean}`, required: true };
    }
    return {
      name: label,
      passed: false,
      detail: `v${clean} (too old)`,
      fix: `Upgrade ${provider.name} to >= ${provider.minimum}`,
      required: true,
    };
  }

  const version = tryExec(containerBin(appbayHome), ["compose", "version", "--short"]);
  if (!version) {
    return {
      name: `Compose >= ${MIN_COMPOSE_VERSION}`,
      passed: false,
      detail: "Could not determine Compose version",
      fix: "Install or upgrade Docker Compose v2",
      required: true,
    };
  }

  // Strip leading 'v' if present.
  const clean = version.replace(/^v/, "");
  if (compareSemver(clean, MIN_COMPOSE_VERSION) >= 0) {
    return {
      name: `Compose >= ${MIN_COMPOSE_VERSION}`,
      passed: true,
      detail: `v${clean}`,
      required: true,
    };
  }

  return {
    name: `Compose >= ${MIN_COMPOSE_VERSION}`,
    passed: false,
    detail: `v${clean} (too old)`,
    fix: `Upgrade Docker Compose to >= ${MIN_COMPOSE_VERSION}`,
    required: true,
  };
}

/**
 * Check if APPBAY_HOME directory exists.
 */
export async function checkAppbayHome(appbayHome: string): Promise<HealthCheckResult> {
  const home = appbayHome;
  try {
    const info = await stat(home);
    if (info.isDirectory()) {
      return { name: "APPBAY_HOME", passed: true, detail: home, required: true };
    }
  } catch {
    // Does not exist.
  }
  return {
    name: "APPBAY_HOME",
    passed: false,
    detail: `${home} does not exist`,
    fix: 'Run "appbay init" to create the Appbay home directory',
    required: true,
  };
}

/**
 * Can the account that will actually RUN the control plane reach the container runtime?
 *
 * ⭐ `checkDockerAccessible` above answers this for the CURRENT USER, and on a service install
 * that is the wrong principal. `appbay init-system --owner service` creates a no-login account
 * that owns `$APPBAY_HOME` and that the systemd unit runs as; the operator running
 * `appbay doctor` is somebody else. So doctor reported a healthy runtime while the account that
 * matters could not reach it at all — the failure only surfaced later, as `server start`
 * exiting 1.
 *
 * 🚨 MEASURED, on Fedora 43 with podman (probe-87, probe-88). The D-6 account fails twice over:
 *
 *     sudo -u appbay podman info
 *       cannot resolve /home/appbay: lstat /home/appbay: no such file or directory
 *
 * because `useradd --no-create-home` leaves `$HOME` pointing at a directory that does not
 * exist — which defeats the ROOTFUL path too, since it fails before the connection is even
 * attempted. With `HOME` set, rootless then fails on absent subuid ranges, and rootful reaches
 * a `srw-rw---- root root` socket it has no permission for.
 *
 * ⚠️ REPORTS "unknown", NEVER "pass", WHEN IT CANNOT TELL. Probing another account needs
 * passwordless sudo. Where that is unavailable this check must not claim the access is fine —
 * that would be the same false green it exists to remove. It is `required: false` for the same
 * reason: an operator install has no second account, and a host without `sudo -n` is not broken.
 */
export function checkServiceAccountRuntimeAccess(
  appbayHome: string,
  deps: {
    ownerOf?: (path: string) => string | null;
    currentUser?: () => string | null;
    probe?: (user: string, bin: string, appbayHome: string) => "ok" | "denied" | "cannot-probe";
  } = {},
): HealthCheckResult {
  const name = "Service account runtime access";
  const bin = containerBin(appbayHome);

  const ownerOf = deps.ownerOf ?? defaultOwnerOf;
  const currentUser = deps.currentUser ?? defaultCurrentUser;
  const probe = deps.probe ?? defaultProbeAs;

  const owner = ownerOf(appbayHome);
  const me = currentUser();

  if (!owner || !me) {
    return { name, passed: true, detail: "cannot determine the owning account (skip)", required: false };
  }
  if (owner === me) {
    // An operator install: the account that runs the control plane is the one asking, and
    // `checkDockerAccessible` already answered for it.
    return { name, passed: true, detail: `runs as you (${me})`, required: false };
  }

  const result = probe(owner, bin, appbayHome);
  if (result === "ok") {
    return { name, passed: true, detail: `${owner} can reach ${bin}`, required: false };
  }
  if (result === "cannot-probe") {
    return {
      name,
      passed: true,
      detail: `cannot verify ${owner}'s access from here (needs passwordless sudo)`,
      // The same argv the check would have run. A hand-typed `sudo -u appbay podman info`
      // exercises the ROOTLESS path and fails on a correctly configured host, so handing the
      // operator that command would send them chasing a problem they do not have.
      fix: `Check it directly:  sudo -u ${owner} ${probeArgv(bin, appbayHome).join(" ")}`,
      required: false,
    };
  }

  return {
    name,
    passed: false,
    detail: `${owner} owns ${appbayHome} but cannot reach ${bin} — the control plane runs as ${owner}, not as you`,
    fix:
      `Run "appbay init-system" — it grants ${owner} access to the runtime.\n` +
      `      Reproduce with:  sudo -n -u ${owner} ${probeArgv(bin, appbayHome).join(" ")}`,
    required: false,
  };
}

/** Login name that owns a path, or null when it cannot be determined. */
function defaultOwnerOf(path: string): string | null {
  try {
    const uid = statSync(path).uid;
    const out = tryExec("getent", ["passwd", String(uid)]);
    return out?.split(":")[0] ?? null;
  } catch {
    return null;
  }
}

function defaultCurrentUser(): string | null {
  const out = tryExec("id", ["-un"]);
  return out?.trim() || null;
}

/**
 * Ask whether `user` can reach the runtime, without becoming them permanently.
 *
 * `sudo -n` so this never prompts inside a health check.
 */
function defaultProbeAs(
  user: string,
  bin: string,
  appbayHome: string,
): "ok" | "denied" | "cannot-probe" {
  // ⚠️ `id -un`, NOT `true`. `tryExec` returns null when stdout is EMPTY even on exit 0
  // (`.trim() || null`), so probing with `sudo -n true` — which succeeds silently — read as
  // "no passwordless sudo" on every host that has it. The check then reported "cannot verify"
  // always, which is a different false answer from the one it exists to remove but no less
  // useless. Caught by running it on a real service install, not by the unit tests, which
  // inject the probe.
  const canSudo = tryExec("sudo", ["-n", "id", "-un"]);
  if (canSudo === null) return "cannot-probe";
  const out = tryExec("sudo", ["-n", "-u", user, ...probeArgv(bin, appbayHome)]);
  return out !== null ? "ok" : "denied";
}

/**
 * The argv that reproduces what the CONTROL PLANE does, not what a shell would do.
 *
 * 🚨 THIS PROBE USED TO EXERCISE THE WRONG CODE PATH. `sudo -n -u appbay podman info` runs with
 * a reset environment, and podman with no `CONTAINER_HOST` goes ROOTLESS — while the systemd
 * unit that actually runs the control plane points at the ROOTFUL socket (S34). On a host where
 * everything was configured correctly, this check would have reported `denied`: a confident
 * answer to a question nobody asked. The environment comes from `podmanRootfulEnv` so the
 * checker and the runner cannot drift apart; `systemd-unit.ts` renders the same record into
 * `Environment=` lines.
 *
 * Docker needs none of this — its group membership is the whole mechanism, and `docker info`
 * with a bare environment is exactly what the daemon sees.
 */
export function probeArgv(bin: string, appbayHome: string): string[] {
  if (!bin.endsWith("podman")) {
    return [bin, "info", "--format", "{{.ServerVersion}}"];
  }
  // 🚨 `{{.ServerVersion}}` IS A DOCKER FIELD. podman's report is `system.infoReport`, which
  // has no such key, so the template ERRORS (exit 125) on every podman host no matter what
  // access the account has. `tryExec` then returns null and this check reported `denied` on a
  // correctly configured host — the exact inversion this function was written to prevent,
  // shipped because unifying the ENVIRONMENT left the ARGV still docker-shaped. Caught only by
  // running `appbay doctor` on a host whose ground truth was known independently.
  const format = ["info", "--format", "{{.Version.Version}}"];
  // `env` rather than relying on sudo's environment handling: `sudo -u` sets HOME from the
  // target account's passwd entry, which is the nonexistent `/home/<user>` that blocks podman
  // in the first place. The home the account really has is the appbay tree it owns — the value
  // `init-system` writes with `usermod -d`.
  const env = podmanRootfulEnv(appbayHome);
  return ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), bin, ...format];
}

/**
 * Check if the appbay_shared Docker network exists.
 */
export function checkNetwork(appbayHome: string): HealthCheckResult {
  const result = tryExec(containerBin(appbayHome), ["network", "inspect", SHARED_NETWORK]);
  if (result !== null) {
    return { name: "appbay_shared network", passed: true, detail: "exists", required: true };
  }
  return {
    name: "appbay_shared network",
    passed: false,
    detail: "network not found",
    fix: `Run "appbay init" or "${containerBin(appbayHome)} network create ${SHARED_NETWORK}"`,
    required: true,
  };
}

/**
 * Check if the Appbay server container is running.
 */
export function checkServer(appbayHome: string): HealthCheckResult {
  const state = tryExec(containerBin(appbayHome), [
    "inspect", "--format", "{{.State.Running}}", SERVER_CONTAINER,
  ]);

  if (state === "true") {
    return {
      name: "Appbay server",
      passed: true,
      detail: `${SERVER_CONTAINER} is running`,
      required: false,
    };
  }

  return {
    name: "Appbay server",
    passed: false,
    detail: `${SERVER_CONTAINER} is not running`,
    fix: 'Run "appbay server start" to start the control plane',
    required: false,
  };
}

/**
 * Check GPU availability via nvidia-smi.
 */
export function checkGpu(appbayHome: string): HealthCheckResult {
  const output = tryExec("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
  if (output) {
    const gpus = output.split("\n").filter(Boolean);
    return {
      name: "GPU",
      passed: true,
      detail: `${gpus.length} GPU(s): ${gpus.join(", ")}`,
      required: false,
    };
  }
  return {
    name: "GPU",
    passed: false,
    detail: "nvidia-smi not found or no GPUs detected",
    fix: "Install NVIDIA drivers and nvidia-container-toolkit for GPU support",
    required: false,
  };
}

/**
 * Check the container service is actually accessible, not just installed.
 *
 * 🚨 THIS IS THE ONE CALL THAT COULD NOT STAY LITERAL, and it failed in the most
 * misleading way possible. `info --format {{.ServerVersion}}` is Docker's schema;
 * Podman's info has no ServerVersion field, so the command exits non-zero with a Go
 * TEMPLATE error — not a connection error. tryExec swallows it, and this check then
 * reported "daemon not responding" against a perfectly healthy Podman, pointing the
 * operator at `systemctl start docker` for a daemon that does not exist on the box.
 *
 * containerServerVersion() picks the right template from the runtime profile. That
 * is the entire divergence — everything else in doctor issues identical commands.
 *
 * 🚨 THE SUDO QUESTION, MADE EXPLICIT. There are two deployment models, and the
 * identity answer differs:
 *
 *   • Standalone host (`appbay init-system`): appbay runs as the OPERATOR's user,
 *     never under sudo. `init-system` adds the user to the container group so no
 *     sudo is needed at runtime.
 *   • DGX fleet (Ansible): appbay runs as ROOT via Ansible `become: true`, against
 *     a tree owned by the `llmsvc` service account (uid 950). It CONSUMES the D-6
 *     uid/ACL model as data — it does not create system accounts or set ACLs.
 *
 * The rule that holds in BOTH models is not "never sudo" — it is that appbay never
 * CREATES system accounts or sets ACLs (that is Ansible's job on the fleet, and
 * `init-system`'s one-time job on a standalone host). Folding uid/ACL creation into
 * the CLI would escalate the whole tool.
 *
 * So this check asks "can the current user reach the daemon WITHOUT sudo?" and
 * distinguishes two failure causes:
 *
 *   1. Daemon is down → fix is to start it (startHint).
 *   2. Daemon is up but the current user lacks permission (rootful docker, user not
 *      in the docker group) → `sudo docker info` succeeds. On a standalone host the
 *      fix is group membership (`sudo usermod -aG docker $USER` + re-login, or
 *      `appbay init-system`). On an Ansible-managed fleet, Ansible arranges access.
 */
export function checkDockerAccessible(appbayHome: string): HealthCheckResult {
  const { displayName, startHint } = runtimeProfile(appbayHome);
  const label = `${displayName} service`;
  const bin = containerBin(appbayHome);
  const version = containerServerVersion(appbayHome);
  if (version) {
    return { name: label, passed: true, detail: `server v${version}`, required: true };
  }

  // The daemon did not answer the current user. Distinguish "down" from
  // "up but needs sudo": if `sudo -n <bin> info` succeeds, the daemon is fine
  // and the problem is the current user's access, not the daemon.
  const sudoProbe = tryExec("sudo", ["-n", bin, "info", "--format", "{{.ServerVersion}}"]);
  if (sudoProbe !== null) {
    return {
      name: label,
      passed: false,
      detail: `${displayName} daemon is up but the current user cannot reach it without sudo`,
      fix:
        `Add your user to the ${displayName.toLowerCase()} group, then log out and back in: ` +
        `sudo usermod -aG ${displayName.toLowerCase()} $USER  (or run "appbay init-system" on a ` +
        `standalone host). On an Ansible-managed fleet, Ansible arranges this. ` +
        `appbay itself never creates system accounts or sets ACLs.`,
      required: true,
    };
  }

  return {
    name: label,
    passed: false,
    detail: `${displayName} service not responding`,
    fix: startHint,
    required: true,
  };
}

/**
 * Detect the container platform for user-friendly messaging.
 *
 * ⚠️ The OrbStack / Colima / Docker Desktop guesses are DOCKER-ONLY, and the fallback
 * was unconditional: with Podman configured on a Mac this reported
 * "macOS (Docker Desktop)" — naming a product that need not be installed at all.
 * `context inspect` itself works on both (Podman aliases it to system connections),
 * so the command stays shared and only the guessing is scoped to the runtime that
 * has those flavours.
 */
export function checkPlatform(appbayHome: string): HealthCheckResult {
  const platform = process.platform === "darwin" ? "macOS" : "Linux";
  const { displayName } = runtimeProfile(appbayHome);
  const context = tryExec(containerBin(appbayHome), ["context", "inspect", "--format", "{{.Name}}"]);

  let runtime = displayName;
  if (context?.includes("orbstack")) runtime = "OrbStack";
  else if (context?.includes("colima")) runtime = "Colima";
  else if (displayName === "Docker" && platform === "macOS") runtime = "Docker Desktop";
  else if (displayName === "Podman" && platform === "macOS") runtime = "Podman machine";

  return {
    name: "Platform",
    passed: true,
    detail: `${platform} (${runtime})`,
    required: false,
  };
}

/**
 * Check Traefik config exists if traefik app is installed.
 */
export function checkTraefikConfig(appbayHome: string): HealthCheckResult {
  const home = appbayHome;
  const traefikDir = join(home, "etc", "apps", "traefik");

  if (!existsSync(traefikDir)) {
    return { name: "Traefik config", passed: true, detail: "traefik not installed (skip)", required: false };
  }

  const configPath = join(traefikDir, "config", "traefik.yml");
  if (existsSync(configPath)) {
    return { name: "Traefik config", passed: true, detail: configPath, required: false };
  }
  return {
    name: "Traefik config",
    passed: false,
    detail: "traefik installed but config/traefik.yml missing",
    fix: 'Run "appbay setup" to scaffold Traefik config, or create it manually',
    required: false,
  };
}

/** Check the integrated Caddy edge has its declarative config and identity directory. */
export function checkCaddySecurityConfig(appbayHome: string): HealthCheckResult {
  const home = appbayHome;
  if (resolveIngressProvider(home) !== "caddy") {
    return { name: "Caddy Security config", passed: true, detail: "Traefik edge selected (skip)", required: false };
  }
  const configDir = join(home, "etc", "apps", "caddy", "config");
  const caddyfile = join(configDir, "Caddyfile");
  const securityDir = join(configDir, "security");
  if (existsSync(caddyfile) && existsSync(securityDir)) {
    return { name: "Caddy Security config", passed: true, detail: "Caddyfile + security directory present", required: true };
  }
  return {
    name: "Caddy Security config",
    passed: false,
    detail: "selected Caddy edge is missing its Caddyfile or security directory",
    fix: 'Run "appbay init --refresh-system-apps" to restore the shipped Caddy stack',
    required: true,
  };
}

/**
 * Check vault initialization status.
 */
export function checkVault(appbayHome: string): HealthCheckResult {
  const home = appbayHome;
  const vaultPath = join(home, "var", "lib", "vault.enc");

  if (existsSync(vaultPath)) {
    return { name: "Secrets vault", passed: true, detail: "vault.enc initialized", required: false };
  }
  return {
    name: "Secrets vault",
    passed: false,
    detail: "vault.enc not initialized",
    fix: 'Run "appbay secrets init" to create the local AES-256-GCM vault',
    required: false,
  };
}

/**
 * Check KeePass database initialization status.
 */
export function checkKeePassDb(appbayHome: string): HealthCheckResult {
  const home = appbayHome;
  const kdbxPath = join(home, "var", "lib", "secrets.kdbx");

  if (existsSync(kdbxPath)) {
    return { name: "KeePass database", passed: true, detail: "secrets.kdbx initialized", required: false };
  }
  return {
    name: "KeePass database",
    passed: false,
    detail: "secrets.kdbx not found",
    fix: 'Run "appbay secrets init-kdbx" to create a KeePass database for keepass:// URIs',
    required: false,
  };
}

/**
 * Check if keepassxc-cli is available for keepass:// secrets.
 */
export function checkKeePassCli(appbayHome: string): HealthCheckResult {
  const version = tryExec("keepassxc-cli", ["--version"]);
  if (version) {
    return {
      name: "keepassxc-cli",
      passed: true,
      detail: version.split("\n")[0].trim(),
      required: false,
    };
  }
  return {
    name: "keepassxc-cli",
    passed: false,
    detail: "keepassxc-cli not found",
    fix: "Required only for keepass:// secret URIs. Install: apt install keepassxc (or brew install keepassxc)",
    required: false,
  };
}

/**
 * Check if the SOPS CLI is available on PATH.
 */
export function checkSops(appbayHome: string): HealthCheckResult {
  const version = tryExec("sops", ["--version"]);
  if (version) {
    return {
      name: "SOPS",
      passed: true,
      detail: version.split("\n")[0].trim(),
      required: false,
    };
  }
  return {
    name: "SOPS",
    passed: false,
    detail: "sops binary not found",
    fix: "Required only for sops:// secret URIs. Install: https://github.com/getsops/sops",
    required: false,
  };
}

/**
 * Check that a container on the shared network can resolve a name via the
 * embedded DNS server.
 *
 * This is the check that actually bit the deployment: apps on `appbay_shared`
 * reach each other by the `<app>_<service>` alias, and when that resolution
 * breaks (network recreated, alias dropped, DNS plugin issue) the app comes up
 * but cannot talk to its dependencies. We probe it by running a throwaway
 * container on the shared network that resolves its own name through the
 * network's embedded DNS server (127.0.0.11) — the same server that serves
 * sibling aliases. If that server is broken, self-resolution fails too, so the
 * probe is a cheap, side-effect-free liveness check for the mechanism sibling
 * resolution depends on.
 *
 * Two earlier probe designs were rejected after live testing on a real network:
 *
 *   • `getent hosts gateway` — busybox is a minimal image and `getent` is an
 *     optional applet that this build does not ship, so the probe failed with
 *     "executable file not found" regardless of DNS health.
 *   • resolving the name `gateway` — Docker's embedded DNS does not register
 *     the network gateway under that name (it returns NXDOMAIN), so the probe
 *     failed on a perfectly healthy network.
 *
 *   • resolving the BARE container name — correct in principle, but a relative
 *     name sends the resolver through the search list first, so on any host with
 *     a search domain the probe queried `<name>.<search>` and reported failure on
 *     a healthy network. See the trailing dot below; this one shipped and made
 *     `appbay doctor` fail a REQUIRED check on every multipass VM.
 *
 * The current probe names the container deterministically and resolves that
 * same name AS AN ABSOLUTE NAME (trailing dot) with `nslookup` (a standard
 * busybox applet with clean exit codes: 0 on success, non-zero on NXDOMAIN).
 * Docker's embedded DNS always registers a container's own name, so this
 * resolves on any healthy network without depending on pre-existing siblings,
 * platform-specific names, or the host's DNS search configuration.
 *
 * The probe container is removed after the check. If the runtime is down or the
 * network is absent, the check reports the underlying cause rather than a
 * generic "DNS failed".
 */
export function checkSharedNetworkDns(appbayHome: string): HealthCheckResult {
  const { displayName } = runtimeProfile(appbayHome);
  const bin = containerBin(appbayHome);

  // The network must exist before we can attach a probe to it.
  const netExists = tryExec(bin, ["network", "inspect", SHARED_NETWORK]);
  if (netExists === null) {
    return {
      name: "Shared network DNS",
      passed: false,
      detail: `${SHARED_NETWORK} network not found — cannot probe DNS resolution`,
      fix: `Run "appbay init" or "${bin} network create ${SHARED_NETWORK}"`,
      required: true,
    };
  }

  // Run a throwaway container on the shared network that resolves its own name
  // via the embedded DNS. `nslookup <name>` returns 0 when the name resolves.
  // The fixed name is safe because `--rm` removes the container on exit; a
  // stale container from a crash would surface as a clear "name in use" failure
  // rather than a silent false pass.
  const probeName = "appbay-dns-probe";

  // 🚨 THE TRAILING DOT IS LOAD-BEARING — without it this check FAILED ON HEALTHY HOSTS.
  // A bare name is relative, so the resolver walks the search list from /etc/resolv.conf
  // first. On any host that sets a search domain the query becomes
  // `appbay-dns-probe.<search>`, which NXDOMAINs, and busybox exits 1 without ever trying
  // the bare name. Measured on a multipass VM (search domain `multipass`):
  //     ** server can't find appbay-dns-probe.multipass: NXDOMAIN   -> exit 1
  // while `nslookup appbay-dns-probe.` on the SAME container returns 172.18.0.4.
  //
  // This is a REQUIRED check, so the false negative made `appbay doctor` report
  // "1 required check(s) failed" on a completely healthy install, and sent the operator to
  // a fix that destroys and recreates a working network. Corporate networks with a search
  // domain hit it too — it was never specific to multipass.
  //
  // ⚠️ Keep the dot when editing. It makes the name absolute (FQDN), which is the only way
  // to bypass the search list. Verified the probe still discriminates: a name that does not
  // exist exits 1 even with the dot.
  const probe = tryExec(bin, [
    "run", "--rm", "--network", SHARED_NETWORK,
    "--name", probeName,
    "busybox:latest", "nslookup", `${probeName}.`,
  ]);

  if (probe !== null) {
    return {
      name: "Shared network DNS",
      passed: true,
      detail: `container on ${SHARED_NETWORK} resolved a name via the embedded DNS`,
      required: true,
    };
  }

  return {
    name: "Shared network DNS",
    passed: false,
    detail: `could not resolve a name via the embedded DNS on ${SHARED_NETWORK}`,
    fix: `Recreate the shared network: "${bin} network rm ${SHARED_NETWORK}" then "appbay init"`,
    required: true,
  };
}

/**
 * Check healthcheck `start_period` adequacy for known-slow apps.
 *
 * A healthcheck with a `start_period` shorter than the app's observed startup
 * time will flap: the container is marked unhealthy during the slow boot, and
 * Compose may restart it in a loop. This check inspects the rendered compose
 * files under APPBAY_HOME and warns when a known-slow app's start_period is
 * below a conservative floor.
 *
 * Known-slow apps and their observed startup floors (seconds) are kept in a
 * small table. The check is advisory (optional), not required — a short
 * start_period is a tuning concern, not a broken install.
 */
export function checkHealthcheckStartPeriod(appbayHome: string): HealthCheckResult {
  const home = appbayHome;
  const rendersDir = join(home, "var", "lib", "renders");

  // Known-slow apps: name -> observed startup floor in seconds.
  const SLOW_APPS: Record<string, number> = {
    ollama: 60,
    "open-webui": 45,
    "stable-diffusion": 90,
    comfyui: 90,
  };

  const offenders: string[] = [];

  for (const [appName, floor] of Object.entries(SLOW_APPS)) {
    const renderedPath = join(rendersDir, appName, "docker-compose.rendered.yml");
    if (!existsSync(renderedPath)) continue;
    const text = readFileSafe(renderedPath);
    if (!text) continue;

    // Match `start_period: <value>` under a healthcheck block. Values may be
    // bare seconds ("60s") or plain numbers ("60").
    const match = text.match(/start_period:\s*"?(\d+)(?:s)?"?/i);
    if (!match) continue;
    const startPeriod = Number(match[1]);
    if (startPeriod < floor) {
      offenders.push(`${appName} (start_period ${startPeriod}s < observed ${floor}s)`);
    }
  }

  if (offenders.length === 0) {
    return {
      name: "Healthcheck start_period",
      passed: true,
      detail: "no known-slow app has an undersized start_period",
      required: false,
    };
  }

  return {
    name: "Healthcheck start_period",
    passed: false,
    detail: offenders.join("; "),
    fix: "Raise start_period above the observed startup time in the app's healthcheck (see docs/guide/bootstrap.md)",
    required: false,
  };
}

/** Read a file as UTF-8, returning null on any error. */
function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Run every check and return the results in a stable order.
 *
 * `doctor` reports all of them; `init` uses `requiredChecksFailed()` on the
 * same array as its preflight gate. Order is fixed so output is deterministic.
 */
export async function runChecks(appbayHome: string): Promise<IdentifiedHealthCheck[]> {
  // The id is attached HERE rather than inside each check so the checks stay ignorant of
  // their consumers, and so this list is the one place that enumerates them.
  const tag = (id: HealthCheckId, r: HealthCheckResult): IdentifiedHealthCheck => ({ ...r, id });

  return [
    tag("platform", checkPlatform(appbayHome)),
    tag("runtime", checkDocker(appbayHome)),
    tag("runtime-access", checkDockerAccessible(appbayHome)),
    tag("service-account-runtime-access", checkServiceAccountRuntimeAccess(appbayHome)),
    tag("store-binding", checkStoreBinding(appbayHome)),
    tag("compose", checkComposeInstalled(appbayHome)),
    tag("compose-version", checkComposeVersion(appbayHome)),
    tag("appbay-home", await checkAppbayHome(appbayHome)),
    tag("network", checkNetwork(appbayHome)),
    tag("network-dns", checkSharedNetworkDns(appbayHome)),
    tag("healthcheck-start-period", checkHealthcheckStartPeriod(appbayHome)),
    tag("traefik-config", checkTraefikConfig(appbayHome)),
    tag("caddy-security-config", checkCaddySecurityConfig(appbayHome)),
    tag("vault", checkVault(appbayHome)),
    tag("keepass-db", checkKeePassDb(appbayHome)),
    tag("keepass-cli", checkKeePassCli(appbayHome)),
    tag("server", checkServer(appbayHome)),
    tag("gpu", checkGpu(appbayHome)),
    tag("sops", checkSops(appbayHome)),
  ];
}

/**
 * The subset of checks that failed and are required.
 */
export function requiredChecksFailed(checks: HealthCheckResult[]): HealthCheckResult[] {
  return checks.filter((c) => !c.passed && c.required);
}

/**
 * The environment-level required checks that gate `appbay init`.
 *
 * These are the checks that must pass before init can scaffold anything useful:
 * the container runtime present and reachable, and Compose v2 at a sufficient
 * version. The APPBAY_HOME and shared-network checks are deliberately excluded —
 * init is what creates both, so gating on them would make init impossible on a
 * fresh host.
 */
export async function runInitPreflight(appbayHome: string): Promise<HealthCheckResult[]> {
  return [
    checkDocker(appbayHome),
    checkDockerAccessible(appbayHome),
    checkComposeInstalled(appbayHome),
    checkComposeVersion(appbayHome),
  ];
}

/**
 * Format a single check as a human-readable line.
 */
export function formatCheck(check: HealthCheckResult): string {
  const icon = check.passed ? "\u2713" : "\u2717";
  const reqLabel = check.required ? "" : " (optional)";
  let out = `  ${icon} ${check.name}${reqLabel}\n    ${check.detail}`;
  if (!check.passed && check.fix) {
    out += `\n    Fix: ${check.fix}`;
  }
  return out;
}

/**
 * Format a summary remediation block grouped by required vs optional.
 *
 * Returns an empty string when nothing failed, so callers can skip the block.
 */
export function formatRemediation(checks: HealthCheckResult[]): string {
  const failed = checks.filter((c) => !c.passed);
  if (failed.length === 0) return "";

  const required = failed.filter((c) => c.required);
  const optional = failed.filter((c) => !c.required);

  const lines: string[] = [];
  if (required.length > 0) {
    lines.push("Required fixes:");
    for (const c of required) {
      lines.push(`  - ${c.name}: ${c.fix ?? c.detail}`);
    }
  }
  if (optional.length > 0) {
    lines.push("Optional (recommended):");
    for (const c of optional) {
      lines.push(`  - ${c.name}: ${c.fix ?? c.detail}`);
    }
  }
  return lines.join("\n");
}

/** A single check in the machine-readable `--json` envelope. */
export interface JsonCheck {
  name: string;
  passed: boolean;
  detail: string;
  fix?: string;
  required: boolean;
}

/**
 * Build the `doctor --json` payload: `{ ok, checks[] }` with flat entries.
 *
 * `ok` is true only when every required check passed. Extracted as a pure
 * function so the output shape is unit-testable without invoking the command.
 */
export function buildDoctorJson(checks: HealthCheckResult[]): { ok: boolean; checks: JsonCheck[] } {
  return {
    ok: requiredChecksFailed(checks).length === 0,
    checks: checks.map((c) => ({
      name: c.name,
      passed: c.passed,
      detail: c.detail,
      fix: c.fix,
      required: c.required,
    })),
  };
}
