/**
 * `appbay status [app]` command.
 *
 * Offline-capable status inspection using @appbay/core directly.
 *
 * - If an app name is given: show detailed status including services, traits,
 *   and overlay information from the appbay.yaml definition.
 * - If no app is given: show a summary of all discovered apps.
 *
 * Flags:
 *   --json  output as JSON
 *
 * Exit codes:
 *   0 -- success
 *   1 -- requested app not found
 */

import { Command } from "commander";
import { join, basename } from "node:path";
import { discoverApps, type DiscoveredApp } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { pad } from "../utils/formatting.js";

/**
 * Extract service names from a parsed compose content object.
 */
export function extractServiceNames(composeContent: Record<string, unknown>): string[] {
  const services = composeContent.services;
  if (services && typeof services === "object" && !Array.isArray(services)) {
    return Object.keys(services as Record<string, unknown>).sort();
  }
  return [];
}

/**
 * Build a detailed JSON representation of a single app.
 */
export function appDetailToJson(app: DiscoveredApp): Record<string, unknown> {
  const services = extractServiceNames(app.composeContent);
  const traits = app.appbayConfig?.traits?.map((t) => t.type) ?? [];
  const overlays = app.appbayConfig?.overlays?.map((o) => ({
    when: o.when,
    services: Object.keys(o.services),
  })) ?? [];

  return {
    name: app.name,
    dir: app.dir,
    project: app.appbayConfig?.project ?? "default",
    environment: app.appbayConfig?.environment ?? "default",
    hasAppbayYaml: app.appbayConfig !== null,
    composeFile: basename(app.composePath),
    services,
    traits,
    overlays,
    upstream: app.appbayConfig?.upstream ?? null,
    errors: app.errors.map((e) => ({ file: e.file, message: e.message })),
  };
}

/**
 * Build a summary JSON representation of a single app.
 */
export function appSummaryToJson(app: DiscoveredApp): Record<string, unknown> {
  return {
    name: app.name,
    project: app.appbayConfig?.project ?? "default",
    environment: app.appbayConfig?.environment ?? "default",
    hasAppbayYaml: app.appbayConfig !== null,
    services: extractServiceNames(app.composeContent).length,
    traits: app.appbayConfig?.traits?.length ?? 0,
    errors: app.errors.length,
  };
}

/**
 * Print detailed status for a single app to stdout.
 */
function printAppDetail(app: DiscoveredApp): void {
  const services = extractServiceNames(app.composeContent);
  const traits = app.appbayConfig?.traits ?? [];
  const overlays = app.appbayConfig?.overlays ?? [];

  console.log(`App: ${app.name}`);
  console.log(`  Directory:   ${app.dir}`);
  console.log(`  Project:     ${app.appbayConfig?.project ?? "default"}`);
  console.log(`  Environment: ${app.appbayConfig?.environment ?? "default"}`);
  console.log(`  Compose:     ${basename(app.composePath)}`);
  console.log(`  appbay.yaml: ${app.appbayConfig !== null ? "yes" : "no"}`);

  // Services from compose.
  console.log(`\n  Services (${services.length}):`);
  if (services.length === 0) {
    console.log("    (none)");
  } else {
    for (const svc of services) {
      // Check for service-level traits.
      const svcTraits = app.appbayConfig?.services?.[svc]?.traits ?? [];
      const traitSuffix = svcTraits.length > 0
        ? `  [traits: ${svcTraits.map((t) => t.type).join(", ")}]`
        : "";
      console.log(`    - ${svc}${traitSuffix}`);
    }
  }

  // App-level traits.
  console.log(`\n  Traits (${traits.length}):`);
  if (traits.length === 0) {
    console.log("    (none)");
  } else {
    for (const trait of traits) {
      console.log(`    - ${trait.type}`);
    }
  }

  // Overlays.
  console.log(`\n  Overlays (${overlays.length}):`);
  if (overlays.length === 0) {
    console.log("    (none)");
  } else {
    for (const overlay of overlays) {
      const whenStr = Array.isArray(overlay.when)
        ? `all: [${overlay.when.join(", ")}]`
        : `any: [${overlay.when.any.join(", ")}]`;
      const affectedServices = Object.keys(overlay.services).join(", ");
      console.log(`    - when ${whenStr} -> services: ${affectedServices}`);
    }
  }

  // Upstream.
  if (app.appbayConfig?.upstream) {
    const upstream = app.appbayConfig.upstream;
    console.log("\n  Upstream:");
    if (upstream.source) {
      console.log(`    Source: ${upstream.source}`);
    }
    if (upstream.services?.exclude && upstream.services.exclude.length > 0) {
      console.log(`    Excluded services: ${upstream.services.exclude.join(", ")}`);
    }
    if (upstream.expose && upstream.expose.length > 0) {
      for (const exp of upstream.expose) {
        if (typeof exp === "string") {
          console.log(`    Expose: ${exp}`);
        } else if (typeof exp === "object" && "service" in exp) {
          const e = exp as { service: string; networks?: string[] };
          console.log(`    Expose: ${e.service}${e.networks ? ` on [${e.networks.join(", ")}]` : ""}`);
        } else if (typeof exp === "object") {
          console.log(`    Expose: ${Object.keys(exp).join(", ")}`);
        }
      }
    }
  }

  // Errors.
  if (app.errors.length > 0) {
    console.log(`\n  Errors (${app.errors.length}):`);
    for (const err of app.errors) {
      const fileName = err.file.split("/").pop() ?? err.file;
      console.log(`    - ${fileName}: ${err.message}`);
    }
  }
}

export const statusCommand = new Command("status")
  .description("Show app status and configuration details")
  .argument("[app]", "app name for detailed status (omit for summary)")
  .option("--json", "output as JSON")
  .action(async (app: string | undefined, options: { json?: boolean }) => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");

    // Discover all apps from the filesystem.
    const discovered = await discoverApps({ appsDir });

    // Single app detail mode.
    if (app) {
      const target = discovered.find((a) => a.name === app);
      if (!target) {
        if (options.json) {
          console.log(JSON.stringify({ error: `App "${app}" not found` }));
        } else {
          console.error(`App "${app}" not found in ${appsDir}`);
        }
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify(appDetailToJson(target), null, 2));
      } else {
        printAppDetail(target);
      }
      process.exit(0);
    }

    // Summary mode (no app specified).
    if (discovered.length === 0) {
      if (options.json) {
        console.log(JSON.stringify([]));
      } else {
        console.log(`No apps found in ${appsDir}`);
      }
      process.exit(0);
    }

    if (options.json) {
      console.log(JSON.stringify(discovered.map(appSummaryToJson), null, 2));
      process.exit(0);
    }

    // Table summary.
    const nameWidth = Math.max(14, ...discovered.map((a) => a.name.length + 1));

    console.log(
      `  ${pad("NAME", nameWidth)} ${"SERVICES"}  ${"TRAITS"}  ${"ERRORS"}`,
    );
    console.log(
      `  ${pad("----", nameWidth)} ${"--------"}  ${"------"}  ${"------"}`,
    );

    for (const a of discovered) {
      const services = extractServiceNames(a.composeContent).length;
      const traits = a.appbayConfig?.traits?.length ?? 0;
      const errors = a.errors.length;

      console.log(
        `  ${pad(a.name, nameWidth)} ${pad(String(services), 10)}${pad(String(traits), 8)}${errors}`,
      );
    }

    console.log(`\n${discovered.length} app(s)`);
  });
