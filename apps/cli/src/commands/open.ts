/**
 * `appbay open <app>` command.
 *
 * Resolves the app's URL from its ingress trait host or compose port
 * mappings, then opens it in the default browser.
 *
 * Exit codes:
 *   0 -- browser launched
 *   1 -- app not found or no URL could be resolved
 */

import { Command } from "commander";
import { join } from "node:path";
import { platform } from "node:os";
import { spawnSync } from "node:child_process";
import { discoverApps, type DiscoveredApp } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";

/**
 * Extract the first host port from a compose port mapping string.
 * Handles formats like "8080:80", "127.0.0.1:8080:80", etc.
 * Returns the host port number or null.
 */
export function extractHostPort(portMapping: string): number | null {
  // Strip protocol suffix (e.g. "/tcp", "/udp").
  const clean = portMapping.split("/")[0];
  const parts = clean.split(":");
  if (parts.length === 2) {
    // "hostPort:containerPort"
    return Number(parts[0]) || null;
  }
  if (parts.length === 3) {
    // "host:hostPort:containerPort"
    return Number(parts[1]) || null;
  }
  return null;
}

/**
 * Resolve the URL for an app, trying ingress trait first, then compose ports.
 */
function resolveAppUrl(app: DiscoveredApp): string | null {
  // Try ingress trait host first.
  const traits = app.appbayConfig?.traits ?? [];
  for (const trait of traits) {
    if (trait.type === "ingress" && "host" in trait) {
      const host = (trait as Record<string, unknown>).host as string;
      if (host) {
        // Ingress hosts are typically HTTPS.
        return `https://${host}`;
      }
    }
  }

  // Fall back to compose port mappings.
  const services = app.composeContent?.services as Record<string, Record<string, unknown>> | undefined;
  if (services) {
    for (const svc of Object.values(services)) {
      const ports = svc.ports as (string | number)[] | undefined;
      if (ports && ports.length > 0) {
        const port = extractHostPort(String(ports[0]));
        if (port) {
          return `http://localhost:${port}`;
        }
      }
    }
  }

  return null;
}

/**
 * Open a URL in the default browser using the platform-appropriate command.
 */
function openInBrowser(url: string): void {
  const os = platform();
  let argv: string[];
  if (os === "darwin") {
    argv = ["open", url];
  } else if (os === "win32") {
    argv = ["cmd", "/c", "start", "", url];
  } else {
    argv = ["xdg-open", url];
  }
  spawnSync(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
}

export const openCommand = new Command("open")
  .description("Open an app in the default browser")
  .argument("<app>", "app name")
  .action(async (app: string) => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");

    const discovered = await discoverApps({ appsDir });
    const target = discovered.find((a) => a.name === app);

    if (!target) {
      console.error(`App "${app}" not found in ${appsDir}`);
      process.exit(1);
    }

    const url = resolveAppUrl(target);
    if (!url) {
      console.error(`Could not resolve a URL for "${app}". No ingress trait or port mapping found.`);
      process.exit(1);
    }

    console.log(`Opening ${url}`);
    try {
      openInBrowser(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to open browser: ${msg}`);
      process.exit(1);
    }
  });
