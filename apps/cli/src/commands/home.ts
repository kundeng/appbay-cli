/**
 * `appbay home` command.
 *
 * Prints the resolved APPBAY_HOME path to stdout.
 *
 * Exit codes:
 *   0 -- always
 */

import { Command } from "commander";
import { resolveAppbayHome } from "../utils/appbay-home.js";

export const homeCommand = new Command("home")
  .description("Print the APPBAY_HOME path")
  .action(() => {
    console.log(resolveAppbayHome());
  });
