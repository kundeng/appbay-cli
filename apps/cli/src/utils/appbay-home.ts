/**
 * Centralized APPBAY_HOME resolution utilities.
 *
 * All CLI commands should use these helpers instead of inlining the
 * `process.env.APPBAY_HOME || ...` pattern.
 *
 * Resolution order (highest to lowest priority):
 *   1. `$APPBAY_HOME` env var  — runtime override, wins always
 *   2. System config at `/etc/appbay/config`  — written by `appbay init-system`
 *      (the ownership model + home path decided at the host level)
 *   3. Saved config at `~/.config/appbay/home`  — written by `appbay init`
 *   4. `~/.appbay`  — silent fallback when nothing is configured
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { readSystemConfig } from "./system-config.js";

/** Path to the persisted home-directory config (outside APPBAY_HOME itself). */
const CONFIG_DIR = join(homedir(), ".config", "appbay");
const CONFIG_FILE = join(CONFIG_DIR, "home");

/**
 * Read the persisted Appbay home path saved by `appbay init`.
 *
 * Returns null if no config has been saved yet.
 */
export function readSavedAppbayHome(): string | null {
  if (!existsSync(CONFIG_FILE)) return null;
  const line = readFileSync(CONFIG_FILE, "utf-8").trim();
  return line || null;
}

/**
 * Persist an Appbay home path so future invocations remember it.
 *
 * Creates `~/.config/appbay/home` if it does not exist.
 * Overwrites on re-init so the user can change the location.
 */
export function saveAppbayHome(homePath: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, homePath + "\n", "utf-8");
}

/**
 * Resolve the Appbay home directory.
 *
 * Resolution order:
 *   1. `$APPBAY_HOME` environment variable (runtime override — wins always)
 *   2. System config at `/etc/appbay/config` (written by `appbay init-system`)
 *   3. Saved config at `~/.config/appbay/home` (written by `appbay init`)
 *   4. `~/.appbay` (silent fallback)
 */
export function resolveAppbayHome(): string {
  // 1. Env var override — always wins.
  if (process.env.APPBAY_HOME) return process.env.APPBAY_HOME;
  // 2. System-level decision from `appbay init-system` — this is the host-level
  //    truth about where the tree lives and who owns it. Consulted before the
  //    per-operator config so a service-account install (home under /var/lib,
  //    not ~/appbay) is honoured by every command.
  const system = readSystemConfig();
  if (system?.home) return system.home;
  // 3. Persisted choice from `appbay init`.
  const saved = readSavedAppbayHome();
  if (saved) return saved;
  // 4. Default.
  return join(homedir(), ".appbay");
}

/**
 * Resolve the path to the server compose file.
 *
 * Returns `$APPBAY_HOME/docker-compose.server.yml`.
 */
export function resolveServerCompose(): string {
  return join(resolveAppbayHome(), "docker-compose.server.yml");
}

/**
 * Resolve the path to the apps directory.
 *
 * Returns `$APPBAY_HOME/etc/apps`.
 */
export function resolveAppsDir(): string {
  return join(resolveAppbayHome(), "etc", "apps");
}

/**
 * Resolve the path to the renders directory.
 *
 * Returns `$APPBAY_HOME/var/lib/renders`.
 */
export function resolveRendersDir(): string {
  return join(resolveAppbayHome(), "var", "lib", "renders");
}

/**
 * Resolve the path to the state directory.
 *
 * Returns `$APPBAY_HOME/var/lib/state`.
 */
export function resolveStateDir(): string {
  return join(resolveAppbayHome(), "var", "lib", "state");
}
