import { Command } from "commander";
import { exitWithContainerResult } from "../utils/docker.js";
import { SHARED_NETWORK, containerExec } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";

export const mcpCommand = new Command("mcp")
  .description("MCP (Model Context Protocol) tools")
  .addCommand(
    new Command("inspector")
      .description("Launch the MCP inspector for debugging MCP servers")
      .argument("[url]", "MCP server URL to inspect")
      .action((url?: string) => {
        const args = [
          "run", "--rm", "-it",
          "--network", SHARED_NETWORK,
          "-p", "6274:6274",
          "node:22-slim",
          "npx", "-y", "@modelcontextprotocol/inspector",
        ];

        if (url) args.push(url);

        console.log("Starting MCP Inspector on http://localhost:6274");
        console.log("Press Ctrl+C to stop.\n");

        const result = containerExec(args, { appbayHome: resolveAppbayHome(), stdio: "inherit" });
        exitWithContainerResult(result);
      }),
  );
