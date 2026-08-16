import { Command } from "commander";
import { spawnSync } from "node:child_process";

function findOllamaContainer(): string | null {
  const result = spawnSync(
    "docker",
    ["ps", "--format", "{{.Names}}", "--filter", "name=ollama"],
    { encoding: "utf-8", timeout: 5_000 },
  );
  if (result.status !== 0) return null;
  const names = (result.stdout as string).trim().split("\n").filter(Boolean);
  return names.find((n) => n.includes("ollama")) ?? null;
}

export const ollamaCommand = new Command("ollama")
  .description("Run Ollama CLI commands inside the Ollama container")
  .argument("<args...>", "arguments to pass to ollama (e.g., run llama3, list, show llama3)")
  .allowUnknownOption(true)
  .action((args: string[]) => {
    const container = findOllamaContainer();

    if (!container) {
      console.error("Ollama container is not running.");
      console.error("  Start it with: appbay up ollama");
      process.exit(1);
    }

    const ttyFlag = process.stdin.isTTY ? ["-it"] : ["-i"];
    const result = spawnSync(
      "docker",
      ["exec", ...ttyFlag, container, "ollama", ...args],
      { stdio: "inherit" },
    );

    process.exit(result.status ?? 1);
  });
