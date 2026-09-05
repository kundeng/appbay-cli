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
export type { HealthCheckResult as CheckResult } from "@appbay/core";
export {
  buildDoctorJson,
  formatCheck,
  formatRemediation,
  requiredChecksFailed,
  parseComposeProvider,
  COMPOSE_PROVIDER_MINIMUMS,
} from "@appbay/core";








export function checkHealthcheckStartPeriod(): core.HealthCheckResult {
  return core.checkHealthcheckStartPeriod(resolveAppbayHome());
}










export async function runChecks(): Promise<core.HealthCheckResult[]> {
  return await core.runChecks(resolveAppbayHome());
}

export async function runInitPreflight(): Promise<core.HealthCheckResult[]> {
  return await core.runInitPreflight(resolveAppbayHome());
}

