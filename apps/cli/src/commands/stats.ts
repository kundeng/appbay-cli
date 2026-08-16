import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { cliContainerBin } from "../utils/docker.js";

export const statsCommand = new Command("stats")
  .description("Show resource usage statistics for running containers")
  .option("--no-stream", "disable streaming (show snapshot)")
  .action((options: { stream?: boolean }) => {
    const args = ["stats", "--format", "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}"];

    if (options.stream === false) {
      args.push("--no-stream");
    }

    // Filter to appbay-managed containers
    const ps = spawnSync(cliContainerBin(), ["ps", "--format", "{{.Names}}", "--filter", "name=appbay."], {
      encoding: "utf-8",
    });

    const containers = (ps.stdout ?? "").trim().split("\n").filter(Boolean);
    if (containers.length === 0) {
      console.log("No running Appbay containers.");
      return;
    }

    args.push(...containers);

    spawnSync(cliContainerBin(), args, { stdio: "inherit" });
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
