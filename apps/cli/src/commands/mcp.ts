import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { cliContainerBin } from "../utils/docker.js";

export const mcpCommand = new Command("mcp")
  .description("MCP (Model Context Protocol) tools")
  .addCommand(
    new Command("inspector")
      .description("Launch the MCP inspector for debugging MCP servers")
      .argument("[url]", "MCP server URL to inspect")
      .action((url?: string) => {
        const args = [
          "run", "--rm", "-it",
          "--network", "appbay_shared",
          "-p", "6274:6274",
          "node:22-slim",
          "npx", "-y", "@modelcontextprotocol/inspector",
        ];

        if (url) args.push(url);

        console.log("Starting MCP Inspector on http://localhost:6274");
        console.log("Press Ctrl+C to stop.\n");

        const result = spawnSync(cliContainerBin(), args, { stdio: "inherit" });
        process.exit(result.status ?? 0);
      }),
  );
