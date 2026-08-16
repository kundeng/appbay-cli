/**
 * System-level Appbay config, written by `appbay init-system` and read by
 * `appbay init` (and `doctor`) so the ownership model and home path are decided
 * in ONE place.
 *
 * Why this exists: `init-system` decides WHO owns the appbay tree (operator vs
 * a no-login service account) and WHERE it lives. `init` scaffolds that tree.
 * If the two disagree — e.g. `init-system` created a service account but `init`
 * put the tree in `~/appbay` (the operator's home) — the service account cannot
 * own it. This file is the handshake: `init-system` records the decision here,
 * `init` reads it.
 *
 * The file lives at `/etc/appbay/config` (system-level, not under any user's
 * home) because the decision is a host property, not a per-operator one. It is
 * plain `key: value` lines, not a schema — the same shape as project.yaml.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

/** System-level config directory (outside any user's home). */
export const SYSTEM_CONFIG_DIR = "/etc/appbay";
/** The config file itself. */
export const SYSTEM_CONFIG_FILE = join(SYSTEM_CONFIG_DIR, "config");

/** The ownership model decided by `init-system`. */
export type OwnerModel = "operator" | "service";

/** Parsed system-level config. */
export interface SystemConfig {
  /** Who owns the appbay tree. */
  owner: OwnerModel;
  /** Service account name (only when owner === "service"). */
  serviceUser?: string;
  /** The resolved APPBAY_HOME path. */
  home: string;
}

/**
 * Read the system-level config.
 *
 * Returns null when the file does not exist (no `init-system` run yet, or a
 * personal install that never needed one).
 *
 * @param filePath override the config path (tests use a temp dir).
 */
export function readSystemConfig(filePath: string = SYSTEM_CONFIG_FILE): SystemConfig | null {
  if (!existsSync(filePath)) return null;
  try {
    const text = readFileSync(filePath, "utf-8");
    const get = (key: string): string | undefined => {
      const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
      return m?.[1]?.trim();
    };
    const owner = get("owner");
    const home = get("home");
    if (owner !== "operator" && owner !== "service") return null;
    if (!home) return null;
    return {
      owner,
      serviceUser: get("service_user"),
      home,
    };
  } catch {
    return null;
  }
}

/**
 * Write the system-level config.
 *
 * Requires root (the file lives under /etc). `init-system` runs with sudo, so
 * this is called from there.
 *
 * @param filePath override the config path (tests use a temp dir).
 */
export function writeSystemConfig(config: SystemConfig, filePath: string = SYSTEM_CONFIG_FILE): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const lines = [
    `owner: ${config.owner}`,
    ...(config.serviceUser ? [`service_user: ${config.serviceUser}`] : []),
    `home: ${config.home}`,
  ];
  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}
