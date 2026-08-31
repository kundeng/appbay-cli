/**
 * `appbay home` command — read, explain and repoint APPBAY_HOME.
 *
 * Usage:
 *   appbay home                Print the resolved APPBAY_HOME path
 *   appbay home --explain      Show every tier and which one wins
 *   appbay home set <path>     Persist a new home in ~/.config/appbay/home
 *   appbay home clear          Forget the persisted home (fall back a tier)
 *
 * ⚠️ Why `set`/`clear` exist: the persisted pointer at `~/.config/appbay/home`
 * is written by `appbay init --dir`, and until now nothing could inspect or
 * undo it. A single `init --dir /tmp/scratch` — the shape every test harness
 * has — silently repoints EVERY later command on the workstation at a
 * throwaway tree, and the only recovery was to know the file existed and edit
 * it by hand. A pointer a command can set is a pointer a command must be able
 * to show and reset.
 *
 * `set` refuses when a higher-precedence tier ($APPBAY_HOME or
 * /etc/appbay/config) would shadow the write, because "saved successfully"
 * followed by commands using a different path is the exact failure this
 * command exists to end.
 *
 * Bare `appbay home` still prints the path and nothing else — scripts capture
 * it with `$(appbay home)` and must not start receiving prose.
 *
 * Exit codes:
 *   0 -- printed, explained, set or cleared
 *   1 -- refused: shadowed by a higher tier, or a path that does not exist
 */

import { Command } from "commander";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveAppbayHome,
  explainAppbayHome,
  saveAppbayHome,
  clearSavedAppbayHome,
  tiersShadowingSaved,
  CONFIG_FILE,
  type HomeTier,
} from "../utils/appbay-home.js";
import { checkHomeAssertion, type HomeMismatch } from "@appbay/core";

/** Label shown per tier in `--explain`, in resolution order. */
const TIER_LABEL: Record<string, string> = {
  env: "1. env var",
  system: "2. system config",
  saved: "3. saved config",
  default: "4. built-in default",
};

/**
 * Does this path look like a scaffolded Appbay home?
 *
 * `appbay init` always creates `etc/`, so its absence means the path exists but
 * was never initialised — worth saying out loud rather than discovering later
 * as "No apps found to compile".
 */
function looksScaffolded(path: string): boolean {
  return existsSync(resolve(path, "etc"));
}

/** The recorded-vs-resolved home disagreement for a tree, or null. RFC-001 §2.4. */
function homeMismatchFor(path: string): HomeMismatch | null {
  try {
    return checkHomeAssertion(path, readFileSync(resolve(path, "project.yaml"), "utf-8"));
  } catch {
    return null; // no config to compare against — not a disagreement
  }
}

function printExplanation(): void {
  const { tiers, winner } = explainAppbayHome();
  console.log("APPBAY_HOME resolution (first tier with a value wins):\n");
  for (const tier of tiers) {
    const mark = tier === winner ? "→" : " ";
    const label = TIER_LABEL[tier.source].padEnd(20);
    const value = tier.value ?? "(not set)";
    console.log(`  ${mark} ${label} ${value}`);
    console.log(`    ${" ".repeat(20)} ${tier.origin}`);
  }
  console.log(`\nResolved: ${winner.value}`);

  const warnings: string[] = [];
  if (!existsSync(winner.value as string)) {
    warnings.push("the resolved path does not exist");
  } else if (!looksScaffolded(winner.value as string)) {
    warnings.push("the resolved path has no etc/ — it was never initialised");
  }
  // A saved pointer under a temp dir is the harness-leak signature: it survives
  // the run that wrote it and dies at the next reboot, taking every later
  // command's idea of "home" with it.
  if (winner.source === "saved" && /^\/(tmp|var\/tmp)\//.test(winner.value as string)) {
    warnings.push("the saved pointer is under a temp directory and will not survive a reboot");
  }
  // RFC-001 §2.4: the tree records where it believes it lives. A disagreement means this home
  // was moved or copied, and every path inside it now refers to somewhere it is not.
  const mismatch = homeMismatchFor(winner.value as string);
  if (mismatch) {
    warnings.push(
      `this tree records home: ${mismatch.recorded} but was found at ${mismatch.resolved} — ` +
        "it was moved or copied, and anything that recorded an absolute path inside it " +
        "(runtime socket gid, generated compose) may still point at the old location",
    );
  }
  for (const w of warnings) console.log(`⚠️  ${w}`);
  if (warnings.length > 0) {
    console.log(`\nRepoint with:  appbay home set <path>`);
    console.log(`Or forget it:  appbay home clear`);
  }
}

/** Render the shadowing tiers as a refusal the operator can act on. */
function reportShadowed(shadows: HomeTier[]): void {
  console.error("Refusing to set the saved home: a higher-precedence tier wins.\n");
  for (const t of shadows) {
    console.error(`  ${TIER_LABEL[t.source]} ${t.value}`);
    console.error(`  ${" ".repeat(TIER_LABEL[t.source].length)} ${t.origin}`);
  }
  console.error(
    "\nWriting ~/.config/appbay/home would succeed and change nothing that the",
  );
  console.error("next command observes. Unset the tier above, or pass --force to");
  console.error("write the saved tier anyway (it stays shadowed until you do).");
}

const setCommand = new Command("set")
  .description("Persist the APPBAY_HOME path used by future commands")
  .argument("<path>", "directory to use as APPBAY_HOME")
  .option("--force", "write even if a higher tier shadows it, or the path is missing")
  .action((path: string, options: { force?: boolean }) => {
    // Store absolute: a relative pointer resolves against whatever directory a
    // later command happens to run in, which is not a property of the install.
    const target = resolve(path);

    const shadows = tiersShadowingSaved();
    if (shadows.length > 0 && !options.force) {
      reportShadowed(shadows);
      process.exit(1);
    }

    if (!existsSync(target)) {
      if (!options.force) {
        console.error(`Refusing to set a home that does not exist: ${target}`);
        console.error("Run `appbay init --dir <path>` to create it, or pass --force.");
        process.exit(1);
      }
      console.log(`⚠️  ${target} does not exist yet`);
    } else if (!statSync(target).isDirectory()) {
      console.error(`Refusing to set a home that is not a directory: ${target}`);
      process.exit(1);
    } else if (!looksScaffolded(target)) {
      console.log(`⚠️  ${target} has no etc/ — it does not look initialised`);
    }

    saveAppbayHome(target);
    console.log(`Saved ${target} to ${CONFIG_FILE}`);

    if (shadows.length > 0) {
      console.log(
        `⚠️  still shadowed by ${TIER_LABEL[shadows[0].source]} — commands will use ${shadows[0].value}`,
      );
      return;
    }
    console.log(`Resolved home is now ${resolveAppbayHome()}`);
  });

const clearCommand = new Command("clear")
  .description("Forget the persisted home and fall back to the next tier")
  .action(() => {
    const removed = clearSavedAppbayHome();
    console.log(
      removed ? `Removed ${CONFIG_FILE}` : `Nothing to clear — ${CONFIG_FILE} is not set`,
    );
    console.log(`Resolved home is now ${resolveAppbayHome()}`);
  });

export const homeCommand = new Command("home")
  .description("Print, explain or repoint the APPBAY_HOME path")
  .option("--explain", "show every resolution tier and which one wins")
  .action((options: { explain?: boolean }) => {
    if (options.explain) {
      printExplanation();
      return;
    }
    console.log(resolveAppbayHome());
  })
  .addCommand(setCommand)
  .addCommand(clearCommand);
