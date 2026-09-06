import { Command } from "commander";
import { containerExec } from "@appbay/core";
import { requireRunningApp } from "../utils/docker.js";
import { resolveAppbayHome } from "../utils/appbay-home.js";

export const ollamaCommand = new Command("ollama")
  .description("Run Ollama CLI commands inside the Ollama container")
  .argument("<args...>", "arguments to pass to ollama (e.g., run llama3, list, show llama3)")
  .allowUnknownOption(true)
  .action(async (args: string[]) => {
    const container = await requireRunningApp("ollama");

    const ttyFlag = process.stdin.isTTY ? ["-it"] : ["-i"];
    const result = containerExec(
      ["exec", ...ttyFlag, container, "ollama", ...args],
      { appbayHome: resolveAppbayHome(), stdio: "inherit" },
    );

    process.exit(result.exitCode);
  });
