/**
 * Shepherd runner — launches ephemeral Docker containers that share
 * namespaces with a target container.
 *
 * Three lifecycle modes:
 *   - One-shot: `docker run --rm` — exits when done (default)
 *   - Scheduled: one-shot fired by a cron runner (same primitive)
 *   - Long-running: compose service with share.* flags (handled by trait emission, not here)
 *
 * This module handles one-shot and scheduled. Long-running sidecars
 * are declared in appbay.yaml and emitted by the hooks trait.
 */

import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { containerSpawnSync } from "../runtime/container-runtime.js";


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShepherdOptions {
  target: string;
  image: string;
  command?: string[];
  share?: {
    network?: boolean;
    pid?: boolean;
    ipc?: boolean;
  };
  mounts?: Array<{
    source: string;
    target: string;
    readonly?: boolean;
    tmpfs?: boolean;
  }>;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Data for the container's stdin. Secrets go here, never in `command` or `env`. */
  stdin?: string;
  /** Test seam: runs the container binary with argv and spawn options. */
  exec?: (argv: string[], spawn: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
}

export interface ShepherdResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Launch an ephemeral shepherd container that optionally shares
 * namespaces with a target container.
 *
 * Uses `docker run --rm` — the container is removed after exit.
 * Namespace sharing flags map to Docker's native primitives:
 *   - share.network → --network=container:<target>
 *   - share.pid → --pid=container:<target>
 *   - share.ipc → --ipc=container:<target>
 */
export async function runShepherd(
  options: ShepherdOptions,
): Promise<ShepherdResult> {
  const args = ["run", "--rm"];

  if (options.share?.network) {
    args.push(`--network=container:${options.target}`);
  }
  if (options.share?.pid) {
    args.push(`--pid=container:${options.target}`);
  }
  if (options.share?.ipc) {
    args.push(`--ipc=container:${options.target}`);
  }

  if (options.mounts) {
    for (const mount of options.mounts) {
      if (mount.tmpfs) {
        args.push("--tmpfs", mount.target);
      } else {
        const mode = mount.readonly ? "ro" : "rw";
        args.push("-v", `${mount.source}:${mount.target}:${mode}`);
      }
    }
  }

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  args.push(options.image);

  if (options.command) {
    args.push(...options.command);
  }

  const timeoutMs = options.timeoutMs ?? 30_000;

  // The payload, when there is one, travels on stdin. Anything on argv is readable by every
  // process on the host for the life of the run, which made the encrypted secret bundle
  // moot: its seed rode beside it on the same command line (review 2026-09-05, ledger 25).
  const run = options.exec ?? ((argv, spawn) => containerSpawnSync(argv, spawn));
  const argv = options.stdin !== undefined ? ["run", "--rm", "-i", ...args.slice(2)] : args;
  const result = run(argv, {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.stdin !== undefined ? { input: options.stdin } : {}),
  });
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { exitCode: 124, stdout, stderr: `Shepherd timed out after ${timeoutMs}ms` };
  }
  if (result.error) return { exitCode: 1, stdout, stderr: stderr || result.error.message };
  return { exitCode: result.status ?? 1, stdout, stderr };
}
