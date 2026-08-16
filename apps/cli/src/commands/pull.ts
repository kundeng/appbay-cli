/**
 * `appbay pull [apps...]` — pull latest images for apps, or pull an Ollama model.
 *
 * If the argument looks like a model name (contains ":" but no "/" path separator,
 * or is a known model family like "llama3", "mistral", etc.), it pulls via the
 * Ollama API. Otherwise it pulls Docker images for the named apps.
 */
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { discoverApps } from "@appbay/core";
import { resolveAppbayHome, resolveAppsDir } from "../utils/appbay-home.js";
import { dockerCompose } from "../utils/docker.js";
import { join } from "node:path";

function looksLikeModel(name: string): boolean {
  if (name.includes("/")) return false;
  if (name.includes(":")) return true;
  const knownFamilies = [
    "llama", "llama2", "llama3", "llama3.1", "llama3.2", "llama3.3",
    "mistral", "mixtral", "phi", "phi3", "phi4", "gemma", "gemma2", "gemma3",
    "qwen", "qwen2", "qwen2.5", "qwen3", "deepseek", "deepseek-r1",
    "codellama", "codegemma", "starcoder", "starcoder2",
    "nomic-embed-text", "all-minilm", "mxbai-embed-large", "snowflake-arctic-embed",
    "llava", "bakllava", "moondream",
    "command-r", "command-r-plus", "dbrx", "yi", "solar", "orca-mini",
    "dolphin-mistral", "dolphin-mixtral", "dolphin-phi", "dolphin-llama3",
    "tinyllama", "tinydolphin", "stablelm2",
  ];
  return knownFamilies.some((f) => name === f || name.startsWith(`${f}:`));
}

function findOllamaContainer(): string | null {
  const ps = spawnSync(
    "docker",
    ["ps", "--format", "{{.Names}}", "--filter", "name=ollama"],
    { encoding: "utf-8", timeout: 5_000 },
  );
  if (ps.status !== 0) return null;
  const names = (ps.stdout as string).trim().split("\n").filter(Boolean);
  return names.find((n) => n.includes("ollama")) ?? null;
}

async function pullModel(name: string): Promise<void> {
  const container = findOllamaContainer();

  if (!container) {
    console.error("Ollama container is not running. Start it with: appbay up ollama");
    process.exit(1);
  }

  console.log(`Pulling model: ${name}`);
  const result = spawnSync(
    "docker",
    ["exec", container, "ollama", "pull", name],
    { stdio: "inherit", timeout: 600_000 },
  );

  if (result.status !== 0) {
    console.error(`Failed to pull model "${name}".`);
    process.exit(1);
  }
}

export const pullCommand = new Command("pull")
  .description("Pull latest images for apps, or pull an Ollama model")
  .argument("[targets...]", "app names or model name (e.g., llama3:latest)")
  .option("--all", "pull all discovered apps")
  .option("--model", "force treat argument as an Ollama model name")
  .action(async (targets: string[], options: { all?: boolean; model?: boolean }) => {
    if (targets.length === 1 && (options.model || looksLikeModel(targets[0]!))) {
      await pullModel(targets[0]!);
      return;
    }

    const home = resolveAppbayHome();
    const appsDir = resolveAppsDir();
    const rendersDir = join(home, "var/lib/renders");

    const discovered = await discoverApps({ appsDir });
    let apps = discovered;

    if (targets.length > 0) {
      const names = new Set(targets);
      apps = discovered.filter((a) => names.has(a.name));
    }

    if (apps.length === 0) {
      console.log("No apps found to pull.");
      return;
    }

    console.log(`Pulling images for ${apps.length} app(s)...\n`);

    let pulled = 0;
    for (const app of apps) {
      const renderPath = join(rendersDir, app.name, "docker-compose.rendered.yml");
      const composePath = app.composePath;
      const target = renderPath || composePath;

      console.log(`  ${app.name}...`);
      const result = dockerCompose(["pull"], target);
      if (result.exitCode === 0) {
        console.log(`    pulled`);
        pulled++;
      } else {
        console.log(`    failed: ${result.output.trim().split("\n")[0]}`);
      }
    }

    console.log(`\n${pulled} pulled`);
  });
