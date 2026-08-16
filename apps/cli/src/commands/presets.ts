/**
 * `appbay presets` — manage named app selection presets.
 *
 * Presets save which apps are active for quick recall:
 *   appbay presets save ai-dev --apps "ollama,webui,whisper"
 *   appbay presets load ai-dev  →  appbay up ollama webui whisper
 *   appbay presets list
 *   appbay presets delete ai-dev
 *
 * Presets are stored as YAML files in $APPBAY_HOME/etc/presets/.
 */
import { Command } from "commander";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { join } from "node:path";
import { readFile, writeFile, readdir, rm, mkdir } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

interface Preset {
  name: string;
  description?: string;
  apps: string[];
  createdAt: string;
}

function presetsDir(home: string): string {
  return join(home, "etc/presets");
}

const presetsCommand = new Command("presets")
  .description("Manage app selection presets");

presetsCommand
  .command("save <name>")
  .description("Save a named app selection preset")
  .option("--apps <list>", "comma-separated app names")
  .option("--description <desc>", "preset description")
  .action(async (name: string, options: { apps?: string; description?: string }) => {
    const home = resolveAppbayHome();
    const dir = presetsDir(home);
    await mkdir(dir, { recursive: true });

    if (!options.apps) {
      console.error("Specify apps: --apps ollama,webui,whisper");
      process.exit(1);
    }

    const preset: Preset = {
      name,
      description: options.description,
      apps: options.apps.split(",").map((a) => a.trim()),
      createdAt: new Date().toISOString(),
    };

    await writeFile(join(dir, `${name}.yaml`), stringifyYaml(preset));
    console.log(`Saved preset "${name}" with ${preset.apps.length} app(s): ${preset.apps.join(", ")}`);
  });

presetsCommand
  .command("load <name>")
  .description("Show apps in a preset (pipe to appbay up)")
  .action(async (name: string) => {
    const home = resolveAppbayHome();
    const path = join(presetsDir(home), `${name}.yaml`);

    try {
      const content = await readFile(path, "utf-8");
      const preset = parseYaml(content) as Preset;
      console.log(preset.apps.join(" "));
    } catch {
      console.error(`Preset "${name}" not found.`);
      process.exit(1);
    }
  });

presetsCommand
  .command("list")
  .description("List saved presets")
  .action(async () => {
    const home = resolveAppbayHome();
    const dir = presetsDir(home);

    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".yaml"));
    } catch {
      console.log("No presets saved yet. Use: appbay presets save <name> --apps a,b,c");
      return;
    }

    if (files.length === 0) {
      console.log("No presets saved yet.");
      return;
    }

    console.log("Saved presets:\n");
    for (const f of files.sort()) {
      const content = await readFile(join(dir, f), "utf-8");
      const preset = parseYaml(content) as Preset;
      const desc = preset.description ? ` — ${preset.description}` : "";
      console.log(`  ${preset.name}${desc}`);
      console.log(`    apps: ${preset.apps.join(", ")}`);
      console.log("");
    }
  });

presetsCommand
  .command("delete <name>")
  .description("Delete a preset")
  .action(async (name: string) => {
    const home = resolveAppbayHome();
    const path = join(presetsDir(home), `${name}.yaml`);

    try {
      await rm(path);
      console.log(`Deleted preset "${name}"`);
    } catch {
      console.error(`Preset "${name}" not found.`);
      process.exit(1);
    }
  });

export { presetsCommand };
