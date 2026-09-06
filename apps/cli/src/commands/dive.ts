import { Command } from "commander";
import { exitWithContainerResult } from "../utils/docker.js";
import { containerExec, resolveRuntimeSocket } from "@appbay/core";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { resolveAppbayHome, resolveAppsDir } from "../utils/appbay-home.js";
import { parse as parseYaml } from "yaml";

function resolveImage(target: string): string {
  // If target contains "/" or ":", treat as direct image reference
  if (target.includes("/") || target.includes(":")) return target;

  // Try to resolve from app's compose file
  // The render's image is the resolved tag; the source may carry `${VAR:-default}`.
  const render = join(resolveAppbayHome(), "var", "lib", "renders", target, "docker-compose.rendered.yml");
  const composePath = existsSync(render) ? render : join(resolveAppsDir(), target, "docker-compose.yml");
  if (existsSync(composePath)) {
    try {
      const compose = parseYaml(readFileSync(composePath, "utf-8"));
      const services = compose?.services ?? {};
      for (const config of Object.values(services) as Array<Record<string, unknown>>) {
        if (config.image && typeof config.image === "string") {
          // A service the compiler did not pin keeps compose's `${VAR:-default}`; the default is the image.
          return config.image.replace(/^\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]+)\}$/, "$1");
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

    const result = containerExec(
      [
        "run", "--rm", "-it",
        "-v", `${resolveRuntimeSocket()}:/var/run/docker.sock`,
        "wagoodman/dive:latest",
        image,
      ],
      { appbayHome: resolveAppbayHome(), stdio: "inherit" },
    );

    exitWithContainerResult(result);
  });
