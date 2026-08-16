import { Command } from "commander";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { catalogGet, catalogInstall } from "@appbay/core";
import { createInterface } from "node:readline";

export const installCommand = new Command("install")
  .description("Install an app from the catalog")
  .argument("<name>", "catalog app to install")
  .option("--set <pairs...>", "set input values (KEY=VALUE)")
  .option("--force", "overwrite if app already exists")
  .option("--no-validate", "skip post-install validation")
  .action(
    async (
      name: string,
      options: {
        set?: string[];
        force?: boolean;
        validate?: boolean;
      },
    ) => {
      const home = resolveAppbayHome();

      // Look up catalog entry for display and input prompting
      const info = await catalogGet(home, name);
      if (!info) {
        console.error(`App "${name}" not found in catalog.`);
        process.exit(1);
      }

      console.log(`Installing ${name} (${info.entry.entry.readiness})...`);
      if (info.entry.entry.description) {
        console.log(`  ${info.entry.entry.description}`);
      }

      // Collect input values from --set flags
      const inputValues: Record<string, string> = {};
      if (options.set) {
        for (const pair of options.set) {
          const eq = pair.indexOf("=");
          if (eq === -1) {
            console.error(`Invalid --set value: ${pair} (expected KEY=VALUE)`);
            process.exit(1);
          }
          inputValues[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
      }

      // Prompt for missing required inputs (CLI-specific interactive concern)
      const requiredInputs = info.entry.entry.required_inputs;
      const missing = requiredInputs.filter(
        (input) => !(input.name in inputValues),
      );

      if (missing.length > 0 && process.stdin.isTTY) {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const ask = (q: string): Promise<string> =>
          new Promise((resolve) => rl.question(q, resolve));

        console.log("\nRequired inputs:");
        for (const input of missing) {
          const defaultStr =
            input.default !== undefined ? ` [${input.default}]` : "";
          const autoStr =
            input.type === "secret" && input.auto_generate
              ? " (auto-generated if empty)"
              : "";
          const answer = await ask(
            `  ${input.name} — ${input.description}${defaultStr}${autoStr}: `,
          );
          if (answer.trim()) {
            inputValues[input.name] = answer.trim();
          } else if (input.default !== undefined) {
            inputValues[input.name] = String(input.default);
          }
        }
        rl.close();
      } else if (missing.length > 0) {
        const missingNames = missing
          .filter(
            (i) =>
              i.default === undefined &&
              !(i.type === "secret" && i.auto_generate),
          )
          .map((i) => i.name);
        if (missingNames.length > 0) {
          console.error(
            `Missing required inputs (not a TTY, use --set): ${missingNames.join(", ")}`,
          );
          process.exit(1);
        }
        for (const input of missing) {
          if (input.default !== undefined) {
            inputValues[input.name] = String(input.default);
          }
        }
      }

      // Delegate to service layer (upstream model: frozen compose + vault secrets + .env.local overrides)
      const result = await catalogInstall({
        appbayHome: home,
        name,
        values: inputValues,
        force: options.force,
      });

      if (!result.success) {
        console.error(result.message);
        process.exit(1);
      }

      console.log(`\nInstalled to ${result.appDir}`);

      if (result.secretsWired && result.secretsWired.length > 0) {
        console.log("\nSecrets wired:");
        for (const s of result.secretsWired) {
          console.log(`  • ${s}`);
        }
      }

      // Post-install validation
      if (options.validate !== false) {
        try {
          const { execSync } = await import("node:child_process");
          execSync(`appbay validate ${name}`, {
            stdio: "inherit",
            env: { ...process.env, APPBAY_HOME: home },
          });
        } catch {
          console.log(
            "\nValidation had issues — review the output above. The app is still installed.",
          );
        }
      }

      console.log(`\nReady to deploy: appbay up ${name}`);
    },
  );
