/**
 * `appbay env <app> [key] [value]` — manage app environment variables.
 *
 * Thin CLI wrapper over @appbay/core config-service.
 */
import { Command } from "commander";
import {
  getAppEnv,
  setAppEnvVar,
  deleteAppEnvVar,
} from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";

export { parseEnvFile, serializeEnv } from "@appbay/core";

export const envCommand = new Command("env")
  .description("Manage app environment variables (.env)")
  .argument("<app>", "app name")
  .argument("[key]", "variable name")
  .argument("[value]", "variable value (set mode)")
  .option("--list", "list all variables")
  .option("--delete", "delete a variable")
  .action(
    async (
      app: string,
      key?: string,
      value?: string,
      options?: { list?: boolean; delete?: boolean },
    ) => {
      const appbayHome = resolveAppbayHome();

      const { vars, path: envPath } = await getAppEnv(appbayHome, app);

      // List mode
      if (!key || options?.list) {
        if (vars.size === 0) {
          console.log(`No environment variables set for "${app}".`);
          console.log(`File: ${envPath}`);
          return;
        }
        console.log(`Environment variables for "${app}":\n`);
        for (const [k, v] of vars) {
          console.log(`  ${k}=${v}`);
        }
        console.log(`\n  ${vars.size} variable(s) in ${envPath}`);
        return;
      }

      // Delete mode
      if (options?.delete) {
        const deleted = await deleteAppEnvVar(appbayHome, app, key);
        console.log(deleted ? `Deleted ${key} from ${app}` : `${key} not found in ${app}`);
        return;
      }

      // Get mode (key but no value)
      if (key && !value) {
        const val = vars.get(key);
        if (val !== undefined) {
          console.log(val);
        } else {
          console.error(`${key} not set in ${app}`);
          process.exit(1);
        }
        return;
      }

      // Set mode (key + value)
      if (key && value) {
        await setAppEnvVar(appbayHome, app, key, value);
        console.log(`Set ${key}=${value} in ${app}`);
        return;
      }
    },
  );
