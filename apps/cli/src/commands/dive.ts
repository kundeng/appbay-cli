import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { resolveAppsDir } from "../utils/appbay-home.js";
import { parse as parseYaml } from "yaml";

function resolveImage(target: string): string {
  // If target contains "/" or ":", treat as direct image reference
  if (target.includes("/") || target.includes(":")) return target;

  // Try to resolve from app's compose file
  const appsDir = resolveAppsDir();
  const composePath = join(appsDir, target, "docker-compose.yml");
  if (existsSync(composePath)) {
    try {
      const compose = parseYaml(readFileSync(composePath, "utf-8"));
      const services = compose?.services ?? {};
      for (const config of Object.values(services) as Array<Record<string, unknown>>) {
        if (config.image && typeof config.image === "string") {
          return config.image;
        }
      }
    } catch { /* fall through */ }
  }

  return target;
}

export const diveCommand = new Command("dive")
  .description("Inspect Docker image layers (disk usage breakdown)")
  .argument("<target>", "app name or image reference (e.g., ollama or nginx:latest)")
  .action((target: string) => {
    const image = resolveImage(target);
    console.log(`Inspecting: ${image}\n`);

    const result = spawnSync(
      "docker",
      [
        "run", "--rm", "-it",
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "wagoodman/dive:latest",
        image,
      ],
      { stdio: "inherit" },
    );

    process.exit(result.status ?? 0);
  });
