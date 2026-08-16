/**
 * Post-deploy orchestration hooks.
 *
 * Imperative steps that run AFTER `docker compose up` and health gate,
 * but BEFORE the deploy is reported as successful. Used by system apps
 * for setup that can't be expressed in compose (API calls, token creation,
 * service registration).
 *
 * These are NOT compose lifecycle hooks (init/sidecar/config — those modify
 * the compose file at compile time). These run in the CLI process at deploy
 * time, with access to the host filesystem and network.
 *
 * The CLI shepherd executes post-deploy hooks as phase 5 of the pipeline:
 *   1. Compile  2. Resolve secrets  3. Deploy  4. Health gate  5. Post-deploy
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context passed to post-deploy hooks. */
export interface PostDeployContext {
  /** App name being deployed. */
  appName: string;
  /** Resolved APPBAY_HOME path. */
  appbayHome: string;
  /** Resolved secrets (env var name → value) from the secret resolution phase. */
  secretEnv: Record<string, string>;
}

/** A post-deploy hook function. */
export type PostDeployHook = (ctx: PostDeployContext) => Promise<void>;

// ---------------------------------------------------------------------------
// Health check (phase 4 of the shepherd pipeline)
// ---------------------------------------------------------------------------

/**
 * Wait until a URL returns a successful HTTP response.
 *
 * Polls with exponential backoff (1s, 2s, 4s, ...) up to the timeout.
 * Used as the health gate between deploy and post-deploy phases.
 *
 * @param url - URL to poll (e.g., `http://localhost:8080/health`).
 * @param timeoutMs - Maximum time to wait (default: 60s).
 * @returns true if healthy within timeout, false otherwise.
 */
export async function waitForHealthy(
  url: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const start = Date.now();
  let delay = 1000;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return true;
    } catch {
      // Not ready yet — retry after delay.
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 10_000); // Cap at 10s between polls.
  }

  return false;
}

/**
 * Wait until a Docker container reports healthy via `docker inspect`.
 *
 * @param containerName - Container name to check (e.g., "appbay.traefik").
 * @param timeoutMs - Maximum time to wait (default: 60s).
 */
export async function waitForContainerHealthy(
  containerName: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const start = Date.now();
  let delay = 2000;

  while (Date.now() - start < timeoutMs) {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["inspect", "--format", "{{.State.Health.Status}}", containerName],
        { timeout: 5_000 },
      );
      const status = stdout.trim();
      if (status === "healthy") return true;
      if (status === "unhealthy") return false; // Don't keep waiting.
    } catch {
      // Container may not exist yet or no healthcheck defined — retry.
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 10_000);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Hook registry
// ---------------------------------------------------------------------------

/** Registry of post-deploy hooks keyed by app name. */
const hookRegistry = new Map<string, PostDeployHook>();

/** Register a post-deploy hook for a specific app. */
export function registerPostDeployHook(
  appName: string,
  hook: PostDeployHook,
): void {
  hookRegistry.set(appName, hook);
}

/** Get the post-deploy hook for an app, or undefined if none registered. */
export function getPostDeployHook(appName: string): PostDeployHook | undefined {
  return hookRegistry.get(appName);
}

/**
 * Run the post-deploy hook for an app if one is registered.
 *
 * @returns true if the hook ran successfully (or no hook registered),
 *   false if the hook threw an error.
 */
export async function runPostDeployHook(
  ctx: PostDeployContext,
): Promise<{ ran: boolean; error?: string }> {
  const hook = hookRegistry.get(ctx.appName);
  if (!hook) {
    return { ran: false };
  }

  try {
    await hook(ctx);
    return { ran: true };
  } catch (err) {
    return {
      ran: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Built-in system app hooks (registered at import time)
// ---------------------------------------------------------------------------

// Traefik: verify the dashboard is accessible after deploy.
registerPostDeployHook("traefik", async (ctx) => {
  const port = 8080; // Traefik dashboard default port
  const url = `http://localhost:${port}/api/version`;
  const healthy = await waitForHealthy(url, 30_000);
  if (!healthy) {
    throw new Error(
      `Traefik dashboard not responding at ${url} after 30s. Check traefik container logs.`,
    );
  }
});
