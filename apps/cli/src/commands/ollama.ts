import { Command } from "commander";
import { cliContainerBin, requireRunningApp } from "../utils/docker.js";
import { spawnSync } from "node:child_process";

export const ollamaCommand = new Command("ollama")
  .description("Run Ollama CLI commands inside the Ollama container")
  .argument("<args...>", "arguments to pass to ollama (e.g., run llama3, list, show llama3)")
  .allowUnknownOption(true)
  .action((args: string[]) => {
    const container = requireRunningApp("ollama");

    const ttyFlag = process.stdin.isTTY ? ["-it"] : ["-i"];
    const result = spawnSync(
      cliContainerBin(),
      ["exec", ...ttyFlag, container, "ollama", ...args],
      { stdio: "inherit" },
    );

    process.exit(result.status ?? 1);
  });
