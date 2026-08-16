/**
 * `appbay config <app> [key] [value]` command.
 *
 * Thin CLI wrapper over @appbay/core config-service.
 *
 * Usage:
 *   appbay config <app>              Show all config for the app
 *   appbay config <app> <key>        Show a specific config value
 *   appbay config <app> <key> <val>  Set a config value
 *
 * Exit codes:
 *   0 -- success
 *   1 -- app not found or key not found
 */

import { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";
import {
  getAppConfig,
  getAppConfigValue,
  setAppConfigValue,
} from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";

export { getByPath, setByPath, coerceValue } from "@appbay/core";

export const configCommand = new Command("config")
  .description("Get or set app configuration values in appbay.yaml")
  .argument("<app>", "app name")
  .argument("[key]", "config key (dot-separated path)")
  .argument("[value]", "value to set")
  .action(async (app: string, key: string | undefined, value: string | undefined) => {
    const appbayHome = resolveAppbayHome();

    // Mode 1: Show all config.
    if (key === undefined) {
      const result = await getAppConfig(appbayHome, app);
      if (!result) {
        console.error(`App "${app}" not found or has no appbay.yaml`);
        process.exit(1);
      }
      console.log(stringifyYaml(result.config).trimEnd());
      return;
    }

    // Mode 2: Get a specific key.
    if (value === undefined) {
      const result = await getAppConfigValue(appbayHome, app, key);
      if (!result.found) {
        console.error(`Key "${key}" not found in ${app}/appbay.yaml`);
        process.exit(1);
      }
      if (typeof result.value === "object" && result.value !== null) {
        console.log(stringifyYaml(result.value as Record<string, unknown>).trimEnd());
      } else {
        console.log(String(result.value));
      }
      return;
    }

    // Mode 3: Set a key.
    await setAppConfigValue(appbayHome, app, key, value);
    console.log(`Set ${app} ${key} = ${value}`);
  });
