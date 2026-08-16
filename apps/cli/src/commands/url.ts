/**
 * `appbay url <app>` — print the app URL without opening browser.
 */
import { Command } from "commander";
import { discoverApps } from "@appbay/core";
import { resolveAppbayHome, resolveAppsDir } from "../utils/appbay-home.js";
import { extractHostPort } from "./url-utils.js";

export const urlCommand = new Command("url")
  .description("Print app URL")
  .argument("<app>", "app name")
  .option("--lan", "show LAN address")
  .option("--internal", "show internal Docker address")
  .action(async (app: string, options: { lan?: boolean; internal?: boolean }) => {
    const appsDir = resolveAppsDir();
    const discovered = await discoverApps({ appsDir });
    const target = discovered.find((a) => a.name === app);

    if (!target) {
      console.error(`App "${app}" not found.`);
      process.exit(1);
    }

    // Try to resolve URL from ingress trait or compose ports
    const config = target.appbayConfig;
    let url: string | null = null;

    if (config) {
      // Check traits for ingress
      const traits = (config as Record<string, unknown>).traits as Array<Record<string, unknown>> | undefined;
      const ingress = traits?.find((t) => t.type === "ingress") as Record<string, unknown> | undefined;
      if (ingress) {
        const host = ingress.host as string;
        const port = (ingress.port as number) || 80;
        if (options.internal) {
          url = `http://${app}_${ingress.service || app}:${port}`;
        } else {
          url = port === 443 ? `https://${host}` : `http://${host}`;
        }
      }
    }

    // Fallback: check compose ports
    if (!url) {
      const services = (target.composeContent?.services || {}) as Record<string, Record<string, unknown>>;
      for (const [, svc] of Object.entries(services)) {
        const ports = svc.ports as string[] | undefined;
        if (ports?.length) {
          const first = String(ports[0]);
          const hostPort = extractHostPort(first);
          url = `http://localhost:${hostPort}`;
          break;
        }
      }
    }

    if (url) {
      console.log(url);
    } else {
      console.error(`No URL found for "${app}". Add an ingress trait or expose ports.`);
      process.exit(1);
    }
  });
