import { Command } from "commander";
import { runningContainerNames, containerExec } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { spawnSync } from "node:child_process";

export const statsCommand = new Command("stats")
  .description("Show resource usage statistics for running containers")
  .option("--no-stream", "disable streaming (show snapshot)")
  .action(async (options: { stream?: boolean }) => {
    const args = ["stats", "--format", "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}"];

    if (options.stream === false) {
      args.push("--no-stream");
    }

    // Filter to appbay-managed containers
    const named = await runningContainerNames("appbay.", resolveAppbayHome());
    if (named.kind === "unknown") {
      console.error(`Could not list containers: ${named.reason}`);
      process.exit(1);
    }
    const containers = named.value;
    if (containers.length === 0) {
      console.log("No running Appbay containers.");
      return;
    }

    args.push(...containers);

    containerExec(args, { appbayHome: resolveAppbayHome(), stdio: "inherit" });
  });

export const smiCommand = new Command("smi")
  .description("Show NVIDIA GPU information")
  .action(() => {
    const result = spawnSync("nvidia-smi", { stdio: "inherit" });
    if (result.error) {
      console.error("nvidia-smi not found. Is the NVIDIA driver installed?");
      process.exit(1);
    }
    process.exit(result.status ?? 0);
  });
