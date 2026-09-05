/**
 * Where APPBAY_HOME is, decided once.
 *
 * Four tiers, highest first: `$APPBAY_HOME`; the host pointer `/etc/appbay/config` that
 * `init-system` writes; the user pointer `~/.config/appbay/home` that `init --dir` writes;
 * `~/.appbay`. Five copies of this decision used to exist, and the CLI published its answer
 * into the environment so core's copies would agree with it. Now there is one.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** Written by `appbay init-system`; a YAML file whose `home:` names the service install. */
export const HOST_POINTER_FILE = "/etc/appbay/config";
/** Written by `appbay init --dir`; one line holding the path. */
export const USER_POINTER_DIR = join(homedir(), ".config", "appbay");
export const USER_POINTER_FILE = join(USER_POINTER_DIR, "home");

export type HomeSource = "env" | "system" | "saved" | "default";

export interface HomeTier {
  source: HomeSource;
  /** Where the value came from, for `appbay home --explain`. */
  origin: string;
  value: string | null;
}

export interface HomeOptions {
  /** Defaults to `process.env.APPBAY_HOME`. */
  env?: string | undefined;
  hostPointerFile?: string;
  userPointerFile?: string;
  /** Defaults to `~/.appbay`. */
  fallback?: string;
}

/** The `home:` a host pointer file records, or null when the file is absent, unreadable, or names none. */
export function readHostPointer(file: string = HOST_POINTER_FILE): string | null {
  if (!existsSync(file)) return null;
  try {
    // Only `home` is read; other keys an older appbay wrote are ignored, not rejected.
    const parsed: unknown = parseYaml(readFileSync(file, "utf-8"));
    const home = parsed && typeof parsed === "object" ? (parsed as { home?: unknown }).home : undefined;
    return typeof home === "string" && home.trim() ? home.trim() : null;
  } catch {
    return null;
  }
}

/** The path a user pointer file records, or null when absent or blank. */
export function readUserPointer(file: string = USER_POINTER_FILE): string | null {
  if (!existsSync(file)) return null;
  try {
    const line = readFileSync(file, "utf-8").trim();
    return line || null;
  } catch {
    return null;
  }
}

/** Every tier with its value, and the one that wins. */
export function explainHome(options: HomeOptions = {}): { tiers: HomeTier[]; winner: HomeTier } {
  const env = "env" in options ? options.env : process.env.APPBAY_HOME;
  const hostFile = options.hostPointerFile ?? HOST_POINTER_FILE;
  const userFile = options.userPointerFile ?? USER_POINTER_FILE;
  const tiers: HomeTier[] = [
    { source: "env", origin: "$APPBAY_HOME", value: env || null },
    { source: "system", origin: hostFile, value: readHostPointer(hostFile) },
    { source: "saved", origin: userFile, value: readUserPointer(userFile) },
    { source: "default", origin: "built-in default", value: options.fallback ?? join(homedir(), ".appbay") },
  ];
  const winner = tiers.find((t) => t.value !== null) as HomeTier;
  return { tiers, winner };
}

/** The home this invocation means. */
export function resolveHome(options: HomeOptions = {}): string {
  return explainHome(options).winner.value as string;
}
