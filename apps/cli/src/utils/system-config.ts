/**
 * System-level Appbay config: where the appbay tree lives on THIS HOST.
 *
 * ⭐ WHY A FILE IN /etc AND NOT A SYSTEMD UNIT. Measured, because RFC-001 2.7 proposed
 * replacing this with `Environment=APPBAY_HOME=` in a unit — see probe-86. A unit sets the
 * environment of the processes systemd starts and nothing else: on a real host the service saw
 * `/var/lib/appbay` and an operator login shell on the same box saw nothing. This file serves
 * the opposite process tree — an operator typing `appbay …` — which is exactly where it
 * matters, because that is the invocation a per-operator `~/.config/appbay/home` would
 * otherwise win. Deleting this tier made the CLI resolve a personal path over a service
 * install. The two are not interchangeable, so 2.7 is refuted rather than pending.
 *
 * ⚠️ IT RECORDS THE HOME AND NOTHING ELSE, SINCE RFC-001 S33. It used to carry `owner` and
 * `service_user` as well — a "handshake" between `init-system` and `init` that never happened:
 * `readSystemConfig()` has two callers and both read `.home`. The ownership decision has real
 * effects, but they are applied at `init-system` time and are observable where they actually
 * live — file ownership and POSIX ACLs on the tree. A second record of them here could only
 * drift from the filesystem, and a stale one is worse than none.
 *
 * 🚨 That drift already had teeth. `owner` was VALIDATED on read: an unrecognised value made
 * the whole file parse to `null`, so the CLI fell through to the per-operator choice and
 * silently resolved a different home — over a field nothing consumed. A typo in a dead field
 * could move an operator's entire installation.
 *
 * Plain `key: value` lines, not a schema — the same shape as the installation config.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

/** System-level config directory (outside any user's home). */
export const SYSTEM_CONFIG_DIR = "/etc/appbay";
/** The config file itself. */
export const SYSTEM_CONFIG_FILE = join(SYSTEM_CONFIG_DIR, "config");

/** Parsed system-level config. */
export interface SystemConfig {
  /** The resolved APPBAY_HOME path for this host. */
  home: string;
}

/**
 * Read the system-level config.
 *
 * Returns null when the file does not exist (no `init-system` run yet, or a personal install
 * that never needed one) or when it names no home.
 *
 * ⚠️ Unknown keys are IGNORED, not rejected. A file written by an older appbay still carries
 * `owner:` and `service_user:`, and must keep resolving — the home is the only thing read, and
 * refusing the file over a field nothing consumes is the bug described in the header.
 *
 * @param filePath override the config path (tests use a temp dir).
 */
export function readSystemConfig(filePath: string = SYSTEM_CONFIG_FILE): SystemConfig | null {
  if (!existsSync(filePath)) return null;
  try {
    const text = readFileSync(filePath, "utf-8");
    const home = text.match(/^home:\s*(.+)$/m)?.[1]?.trim();
    if (!home) return null;
    return { home };
  } catch {
    return null;
  }
}

/**
 * Write the system-level config.
 *
 * Requires root (the file lives under /etc). `init-system` runs with sudo, so this is called
 * from there.
 *
 * @param filePath override the config path (tests use a temp dir).
 */
export function writeSystemConfig(config: SystemConfig, filePath: string = SYSTEM_CONFIG_FILE): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `home: ${config.home}\n`, "utf-8");
}
