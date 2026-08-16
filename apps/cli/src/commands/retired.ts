/** Commands that used to exist, kept only to say what replaced them.
 *
 * ⭐ WHY KEEP THEM AT ALL. Removing a command outright leaves commander printing
 * `error: unknown command 'authelia'`. That is a correct exit code and a useless message:
 * it tells an operator the command is gone but not that the whole identity plane moved,
 * and it reads identically to a typo. Anyone with muscle memory, a runbook, or a config
 * management role calling `appbay authelia users …` learns nothing about where to go.
 *
 * ⚠️ THESE STILL EXIT NON-ZERO. A retirement notice that exits 0 would let a provisioning
 * script "succeed" at configuring authentication it never configured — strictly worse than
 * the unknown-command error this replaces.
 *
 * Delete these once the migration window is over; they carry no behaviour to maintain.
 */

import { Command } from "commander";

interface Retirement {
  /** The retired command name. */
  name: string;
  /** One line on what happened to it. */
  what: string;
  /** Concrete replacements, in the order an operator would need them. */
  steps: string[];
}

const RETIREMENTS: Retirement[] = [
  {
    name: "authelia",
    what: "Authelia is no longer AppBay's authentication edge.",
    steps: [
      "The supported authenticated edge is Caddy with Caddy Security:",
      "    appbay init --ingress-provider caddy",
      "",
      "Edge users (people who sign in to your deployed apps) are now managed with:",
      "    appbay edge users list",
      "    appbay edge users create <username> --generate --reveal",
      "    appbay edge users reset-password <username> --generate --reveal",
      "",
      "⚠️ Edge users are NOT AppBay control-plane accounts. To reset the password you",
      "   use to sign in to AppBay itself, use `appbay admin reset-password` — a",
      "   separate credential domain that is never synchronized with edge identities.",
    ],
  },
  {
    name: "auth",
    what: "`appbay auth` was an alias for the Authelia commands, which are retired.",
    steps: [
      "Per-app access is declared in the app's appbay.yaml, not set from the CLI:",
      "",
      "    traits:",
      "      - type: auth",
      "        policy: authenticated     # or: deny",
      "        group: admins             # optional role requirement",
      "",
      "Applications declare access INTENT. The installation's selected edge decides how",
      "to enforce it, so an app manifest never names a provider.",
      "",
      "For edge user accounts: appbay edge users --help",
      "For the AppBay control-plane account: appbay admin reset-password --help",
    ],
  },
];

function buildRetiredCommand(r: Retirement): Command {
  return new Command(r.name)
    .description(`(retired) ${r.what}`)
    // Swallow any arguments and flags the old form accepted, so `appbay authelia users
    // reset-password admin --generate` reaches this handler instead of failing on an
    // unknown subcommand and printing commander's error instead of ours.
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(() => {
      console.error(`\n  ${r.name} has been retired.\n`);
      console.error(`  ${r.what}\n`);
      for (const line of r.steps) console.error(line ? `  ${line}` : "");
      console.error("");
      process.exitCode = 1;
    });
}

/** Every retired command, ready to register. */
export const retiredCommands: Command[] = RETIREMENTS.map(buildRetiredCommand);
