/**
 * `appbay version` command.
 *
 * Prints the Appbay CLI version from the core package constant.
 *
 * Exit codes:
 *   0 -- always
 */

import { Command } from "commander";
import { VERSION } from "@appbay/core";

export const versionCommand = new Command("version")
  .description("Print Appbay version")
  .action(() => {
    console.log(`appbay ${VERSION}`);
  });
