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
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { readSystemConfig, SYSTEM_CONFIG_FILE } from "./system-config.js";

/** Path to the persisted home-directory config (outside APPBAY_HOME itself). */
export const CONFIG_DIR = join(homedir(), ".config", "appbay");
export const CONFIG_FILE = join(CONFIG_DIR, "home");

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

/** What `saveAppbayHome` did. */
export type SaveHomeResult =
  /** Written to `~/.config/appbay/home`. */
  | "saved"
  /** Not written: the host-level config already records this home, and outranks tier 3. */
  | "unnecessary"
  /** Could not be written. The caller decides whether that matters. */
  | "failed";

/**
 * Persist an Appbay home path so future invocations remember it.
 *
 * 🚨 THIS MUST NOT THROW, AND IT USED TO. `mkdirSync` on `~/.config` raised an unhandled
 * EACCES for a no-login SERVICE ACCOUNT — the one `appbay init-system --owner service` creates
 * by default, with `--no-create-home`, so `$HOME` is a `/home/<user>` that does not exist and
 * cannot be created. Measured on Fedora 43: `appbay init` crashed with a raw bun stack trace
 * on the very step `init-system` prints as "Next". The documented bootstrap path was broken for
 * its own default ownership model.
 *
 * ⚠️ It is also UNNECESSARY there, which is why this is not merely a try/catch. `~/.config` is
 * tier 3 — a per-operator convenience — and `/etc/appbay/config` is tier 2, which outranks it.
 * When the host-level file already names this home, writing a shadowed per-operator copy would
 * only create something that can later disagree with it.
 */
export function saveAppbayHome(homePath: string): SaveHomeResult {
  if (readSystemConfig()?.home === homePath) return "unnecessary";
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, homePath + "\n", "utf-8");
    return "saved";
  } catch {
    return "failed";
  }
}

/**
 * Remove the persisted home path, so resolution falls through to the next tier.
 *
 * Returns true when a config file was actually removed, false when there was
 * nothing to remove — the caller reports "cleared" vs "already unset" rather
 * than claiming a change that did not happen.
 */
export function clearSavedAppbayHome(): boolean {
  if (!existsSync(CONFIG_FILE)) return false;
  rmSync(CONFIG_FILE);
  return true;
}

/**
 * Which tier of {@link resolveAppbayHome} supplied the answer.
 *
 * `env` and `system` both OUTRANK `saved`, which is why they matter to callers:
 * writing `~/.config/appbay/home` while either is present changes nothing that
 * the next command will observe.
 */
/**
 * `APPBAY_HOME` exactly as the CLI was STARTED with — captured before anything synthesises it.
 *
 * 🚨 `index.ts` sets `process.env.APPBAY_HOME = resolveAppbayHome()` when it is absent, so
 * that core (which reads the env var directly) agrees with the CLI about the home. Correct,
 * and it destroys the distinction every caller downstream needs: by the time a command's
 * action runs, the variable is ALWAYS set, and "the operator exported it" is indistinguishable
 * from "we resolved it from ~/.config/appbay/home".
 *
 * `appbay init` branched on `process.env.APPBAY_HOME` before checking `--dir`, so once a
 * saved home existed the env branch always won and **`--dir` was silently ignored** —
 * `appbay init --dir /tmp/x` initialised the saved home and never created `/tmp/x`. The
 * consuming project's converge passes `--dir` (`provision-appbay.yml:687`).
 *
 * This module is imported by `index.ts`, so its top level runs BEFORE that assignment.
 */
export const APPBAY_HOME_FROM_ENV: string | undefined = process.env.APPBAY_HOME;

export type HomeSource = "env" | "system" | "saved" | "default";

/** One tier of the resolution order, and what it currently holds. */
export interface HomeTier {
  source: HomeSource;
  /** Human-readable origin, e.g. `$APPBAY_HOME` or the config file path. */
  origin: string;
  /** The path this tier supplies, or null when the tier is not set. */
  value: string | null;
}

/** The full resolution picture: every tier, and the one that wins. */
export interface HomeExplanation {
  tiers: HomeTier[];
  winner: HomeTier;
}

/**
 * Resolve the home path AND report which tier decided it.
 *
 * `resolveAppbayHome` answers "where"; this answers "why". Keeping the two in
 * one place means `appbay home`, `appbay home set` and `doctor` cannot drift
 * from each other on precedence — a drift that is invisible until a command
 * silently reads a different tree than the operator believes it does.
 */
export function explainAppbayHome(): HomeExplanation {
  const tiers: HomeTier[] = [
    {
      source: "env",
      origin: "$APPBAY_HOME",
      value: process.env.APPBAY_HOME || null,
    },
    {
      source: "system",
      origin: SYSTEM_CONFIG_FILE,
      value: readSystemConfig()?.home ?? null,
    },
    {
      source: "saved",
      origin: CONFIG_FILE,
      value: readSavedAppbayHome(),
    },
    {
      source: "default",
      origin: "built-in default",
      value: join(homedir(), ".appbay"),
    },
  ];
  // The `default` tier always has a value, so this always finds a winner.
  const winner = tiers.find((t) => t.value !== null) as HomeTier;
  return { tiers, winner };
}

/**
 * Tiers that outrank `saved`, restricted to those actually set.
 *
 * A non-empty result means a `home set` will be persisted but NOT observed —
 * the case worth refusing loudly instead of printing a cheerful confirmation.
 */
export function tiersShadowingSaved(): HomeTier[] {
  return explainAppbayHome().tiers.filter(
    (t) => (t.source === "env" || t.source === "system") && t.value !== null,
  );
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
