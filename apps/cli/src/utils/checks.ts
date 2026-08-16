/**
 * CLI binding for the shared health checks.
 *
 * 🚨 THE CHECKS THEMSELVES LIVE IN `@appbay/core` (`health/checks.ts`) AND ARE SHARED WITH
 * THE WEB CONTROL PLANE. There used to be two independent implementations and they drifted:
 * the web copy never received S23's runtime awareness and reported "Docker daemon is not
 * reachable" on healthy Podman hosts. See issue #71.
 *
 * ⚠️ This file exists only to supply the CLI's `resolveAppbayHome()`, which also consults
 * `~/.config/appbay/home` — a lookup core deliberately does not duplicate. Add new checks to
 * core, not here; anything added here is invisible to the web doctor by construction.
 */

import { resolveAppbayHome } from "./appbay-home.js";
import * as core from "@appbay/core";

// Alias the shared type back to the CLI's historical name so its callers are untouched.
export type { HealthCheckResult as CheckResult, ComposeProvider, JsonCheck } from "@appbay/core";
export {
  buildDoctorJson,
  compareSemver,
  formatCheck,
  formatRemediation,
  requiredChecksFailed,
  tryExec,
  parseComposeProvider,
  COMPOSE_PROVIDER_MINIMUMS,
  MIN_COMPOSE_VERSION,
  SERVER_CONTAINER,
  SHARED_NETWORK,
} from "@appbay/core";

export async function checkAppbayHome(): Promise<core.HealthCheckResult> {
  return await core.checkAppbayHome(resolveAppbayHome());
}

export function checkCaddySecurityConfig(): core.HealthCheckResult {
  return core.checkCaddySecurityConfig(resolveAppbayHome());
}

export function checkComposeInstalled(): core.HealthCheckResult {
  return core.checkComposeInstalled(resolveAppbayHome());
}

export function checkComposeVersion(): core.HealthCheckResult {
  return core.checkComposeVersion(resolveAppbayHome());
}

export function checkDocker(): core.HealthCheckResult {
  return core.checkDocker(resolveAppbayHome());
}

export function checkDockerAccessible(): core.HealthCheckResult {
  return core.checkDockerAccessible(resolveAppbayHome());
}

export function checkGpu(): core.HealthCheckResult {
  return core.checkGpu(resolveAppbayHome());
}

export function checkHealthcheckStartPeriod(): core.HealthCheckResult {
  return core.checkHealthcheckStartPeriod(resolveAppbayHome());
}

export function checkKeePassCli(): core.HealthCheckResult {
  return core.checkKeePassCli(resolveAppbayHome());
}

export function checkKeePassDb(): core.HealthCheckResult {
  return core.checkKeePassDb(resolveAppbayHome());
}

export function checkNetwork(): core.HealthCheckResult {
  return core.checkNetwork(resolveAppbayHome());
}

export function checkPlatform(): core.HealthCheckResult {
  return core.checkPlatform(resolveAppbayHome());
}

export function checkServer(): core.HealthCheckResult {
  return core.checkServer(resolveAppbayHome());
}

export function checkSharedNetworkDns(): core.HealthCheckResult {
  return core.checkSharedNetworkDns(resolveAppbayHome());
}

export function checkSops(): core.HealthCheckResult {
  return core.checkSops(resolveAppbayHome());
}

export function checkTraefikConfig(): core.HealthCheckResult {
  return core.checkTraefikConfig(resolveAppbayHome());
}

export function checkVault(): core.HealthCheckResult {
  return core.checkVault(resolveAppbayHome());
}

export async function runChecks(): Promise<core.HealthCheckResult[]> {
  return await core.runChecks(resolveAppbayHome());
}

export async function runInitPreflight(): Promise<core.HealthCheckResult[]> {
  return await core.runInitPreflight(resolveAppbayHome());
}

