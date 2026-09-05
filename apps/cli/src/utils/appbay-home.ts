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

import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { readSystemConfig, SYSTEM_CONFIG_FILE } from "./system-config.js";
import { explainHome, resolveHome, readUserPointer, type HomeTier } from "@appbay/core";

/** Path to the persisted home-directory config (outside APPBAY_HOME itself). */
const CONFIG_DIR = join(homedir(), ".config", "appbay");
export const CONFIG_FILE = join(CONFIG_DIR, "home");

/**
 * Read the persisted Appbay home path saved by `appbay init`.
 *
 * Returns null if no config has been saved yet.
 */
function readSavedAppbayHome(): string | null {
  return readUserPointer(CONFIG_FILE);
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
export function saveAppbayHome(
  homePath: string,
  files: { pointer?: string; hostPointer?: string } = {},
): SaveHomeResult {
  const pointer = files.pointer ?? CONFIG_FILE;
  if (readSystemConfig(files.hostPointer)?.home === homePath) return "unnecessary";
  try {
    mkdirSync(dirname(pointer), { recursive: true });
    writeFileSync(pointer, homePath + "\n", "utf-8");
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
export function clearSavedAppbayHome(pointer: string = CONFIG_FILE): boolean {
  if (!existsSync(pointer)) return false;
  rmSync(pointer);
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

export type HomeExplanation = ReturnType<typeof explainHome>;

/** Every tier and the winner, over this CLI's two pointer files. */
export function explainAppbayHome(): HomeExplanation {
  return explainHome({ hostPointerFile: SYSTEM_CONFIG_FILE, userPointerFile: CONFIG_FILE });
}

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
  return resolveHome({ hostPointerFile: SYSTEM_CONFIG_FILE, userPointerFile: CONFIG_FILE });
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
