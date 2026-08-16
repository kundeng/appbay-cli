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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { containerBin } from "../runtime/container-runtime.js";

const execFileAsync = promisify(execFile);

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

  try {
    const { stdout, stderr } = await execFileAsync(containerBin(), args, {
      encoding: "utf-8",
      timeout: timeoutMs,
    });

    return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: unknown) {
    const execErr = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };

    if (execErr.killed) {
      return {
        exitCode: 124,
        stdout: execErr.stdout?.trim() ?? "",
        stderr: `Shepherd timed out after ${timeoutMs}ms`,
      };
    }

    return {
      exitCode: execErr.code ?? 1,
      stdout: execErr.stdout?.trim() ?? "",
      stderr: execErr.stderr?.trim() ?? (err instanceof Error ? err.message : String(err)),
    };
  }
}
