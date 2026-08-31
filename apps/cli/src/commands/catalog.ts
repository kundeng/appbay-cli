import { Command } from "commander";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import {
  discoverCatalog,
  catalogGet,
  catalogAddSource,
  catalogUpdateSource,
  catalogListSources,
} from "@appbay/core";
import type { DiscoveredCatalogEntry, CatalogOverride } from "@appbay/core";

export const catalogCommand = new Command("catalog")
  .description("Browse and manage the app catalog");

/**
 * Print every name where an added source replaced a bundled app.
 *
 * An override is a correct outcome — an explicitly added source outranks a shipped one —
 * but a *silent* one is not. The two definitions can differ in ways that change the
 * security posture of the host, so the operator is told which app, which source, and which
 * directory won. RFC-001 §6.2.
 */
function reportOverrides(overrides: CatalogOverride[]): void {
  for (const o of overrides) {
    console.error(
      `  override: "${o.name}" resolves to source "${o.source}" (${o.sourceDir}), ` +
        `shadowing the bundled entry at ${o.shadowedDir}`,
    );
  }
}

catalogCommand
  .command("list")
  .description("List all catalog entries")
  .option("--json", "output as JSON")
  .option("--source <name>", "filter by source (bundled, or source name)")
  .option("--readiness <level>", "filter by readiness (raw, augmented, native)")
  .option("--category <cat>", "filter by category")
  .action(
    async (options: {
      json?: boolean;
      source?: string;
      readiness?: string;
      category?: string;
    }) => {
      const home = resolveAppbayHome();
      const { entries, errors, overrides } = await discoverCatalog(home);

      for (const err of errors) {
        console.error(`  warning: ${err.dir}: ${err.message}`);
      }
      reportOverrides(overrides);

      let filtered = entries;
      if (options.source) {
        filtered = filtered.filter((e) => e.source === options.source);
      }
      if (options.readiness) {
        filtered = filtered.filter(
          (e) => e.entry.readiness === options.readiness,
        );
      }
      if (options.category) {
        filtered = filtered.filter(
          (e) => e.entry.category === options.category,
        );
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            // ⚠️ SPREAD FIRST, EXPLICIT KEYS LAST. CatalogEntry carries its OWN `name`
            // and `source`, so with the spread last it silently won and --json emitted
            // different values than the table for the same two columns: e.entry.name
            // instead of the catalog key you actually `appbay install`, and
            // e.entry.source (a CatalogSource OBJECT, often absent) instead of which
            // catalog the entry came from (a string). TS2783 was flagging exactly this.
            filtered.map((e) => ({
              ...e.entry,
              name: e.name,
              source: e.source,
            })),
            null,
            2,
          ),
        );
        return;
      }

      if (filtered.length === 0) {
        console.log("No catalog entries found.");
        if (entries.length === 0) {
          console.log("Run 'appbay init' to seed the catalog.");
        }
        return;
      }

      printTable(filtered);
    },
  );

catalogCommand
  .command("search")
  .description("Search catalog by name, tag, or category")
  .argument("<query>", "search query")
  .option("--json", "output as JSON")
  .action(async (query: string, options: { json?: boolean }) => {
    const home = resolveAppbayHome();
    const { entries, errors, overrides } = await discoverCatalog(home);

    for (const err of errors) {
      console.error(`  warning: ${err.dir}: ${err.message}`);
    }
    reportOverrides(overrides);

    const q = query.toLowerCase();
    const matches = entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.entry.description.toLowerCase().includes(q) ||
        e.entry.category.toLowerCase().includes(q) ||
        e.entry.tags.some((t) => t.toLowerCase().includes(q)),
    );

    if (options.json) {
      console.log(
        JSON.stringify(
          // Same inversion as `catalog list` above — spread first so the catalog key
          // and originating source survive.
          matches.map((e) => ({
            ...e.entry,
            name: e.name,
            source: e.source,
          })),
          null,
          2,
        ),
      );
      return;
    }

    if (matches.length === 0) {
      console.log(`No catalog entries matching "${query}".`);
      return;
    }

    printTable(matches);
  });

catalogCommand
  .command("info")
  .description("Show detailed information about a catalog entry")
  .argument("<name>", "catalog app name")
  .action(async (name: string) => {
    const home = resolveAppbayHome();
    const result = await catalogGet(home, name);

    if (!result) {
      console.error(`App "${name}" not found in catalog.`);
      process.exit(1);
    }

    const e = result.entry.entry;
    console.log(`${e.name} (${e.readiness})`);
    console.log(`  ${e.description}`);
    if (e.version) console.log(`  Version: ${e.version}`);
    console.log(`  Category: ${e.category}`);
    if (e.tags.length > 0) console.log(`  Tags: ${e.tags.join(", ")}`);
    console.log(`  Source: ${result.entry.source}`);
    console.log(`  Maintainer: ${e.maintainer}`);
    console.log(`  Has appbay.yaml: ${result.entry.hasAppbayYaml ? "yes" : "no"}`);
    console.log(`  Has compose: ${result.entry.hasCompose ? "yes" : "no"}`);

    if (e.traits_summary.length > 0) {
      console.log("\n  Traits:");
      for (const t of e.traits_summary) {
        console.log(`    - ${t}`);
      }
    }

    if (e.required_inputs.length > 0) {
      console.log("\n  Required inputs:");
      for (const input of e.required_inputs) {
        const def = input.default !== undefined ? ` [default: ${input.default}]` : "";
        const auto = input.auto_generate ? " (auto-generate)" : "";
        console.log(`    ${input.name} (${input.type})${def}${auto}`);
        console.log(`      ${input.description}`);
      }
    }

    if (result.appbayYaml) {
      console.log("\n  appbay.yaml preview:");
      for (const line of result.appbayYaml.split("\n").slice(0, 15)) {
        console.log(`    ${line}`);
      }
      const totalLines = result.appbayYaml.split("\n").length;
      if (totalLines > 15) {
        console.log(`    ... (${totalLines - 15} more lines)`);
      }
    }
  });

catalogCommand
  .command("add-source")
  .description("Add an external catalog source (git repo)")
  .argument("<name>", "source name")
  .argument("<url>", "git repository URL")
  .action(async (name: string, url: string) => {
    const home = resolveAppbayHome();
    console.log(`Adding catalog source "${name}" from ${url}...`);
    const result = await catalogAddSource(home, name, url);
    if (result.success) {
      console.log(result.message);
    } else {
      console.error(result.message);
      process.exit(1);
    }
  });

catalogCommand
  .command("update")
  .description("Update catalog sources (git pull)")
  .argument("[source]", "specific source to update (default: all)")
  .action(async (source?: string) => {
    const home = resolveAppbayHome();
    console.log("Updating catalog sources...\n");
    const results = await catalogUpdateSource(home, source);
    for (const r of results) {
      const icon = r.success ? "✓" : "✗";
      console.log(`  ${icon} ${r.name}: ${r.message}`);
    }
  });

catalogCommand
  .command("sources")
  .description("List configured catalog sources")
  .action(async () => {
    const home = resolveAppbayHome();
    const sources = await catalogListSources(home);

    if (sources.length === 0) {
      console.log("No catalog sources configured.");
      return;
    }

    const nameW = Math.max(6, ...sources.map((s) => s.name.length));
    const urlW = Math.max(3, ...sources.map((s) => s.url.length));

    console.log(
      ["SOURCE".padEnd(nameW), "ENTRIES", "ADDED", "URL"].join("  "),
    );
    console.log("-".repeat(nameW + urlW + 25));

    for (const s of sources) {
      console.log(
        [
          s.name.padEnd(nameW),
          String(s.entryCount).padStart(7),
          s.added.padEnd(10),
          s.url,
        ].join("  "),
      );
    }
  });

function printTable(entries: DiscoveredCatalogEntry[]): void {
  const nameW = Math.max(4, ...entries.map((e) => e.name.length));
  const readW = 9; // "augmented".length
  const catW = Math.max(8, ...entries.map((e) => e.entry.category.length));
  const srcW = Math.max(6, ...entries.map((e) => e.source.length));

  const header = [
    "NAME".padEnd(nameW),
    "READINESS".padEnd(readW),
    "CATEGORY".padEnd(catW),
    "SOURCE".padEnd(srcW),
    "DESCRIPTION",
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const e of entries) {
    const desc =
      e.entry.description.length > 50
        ? e.entry.description.slice(0, 47) + "..."
        : e.entry.description;
    console.log(
      [
        e.name.padEnd(nameW),
        e.entry.readiness.padEnd(readW),
        e.entry.category.padEnd(catW),
        e.source.padEnd(srcW),
        desc,
      ].join("  "),
    );
  }

  console.log(`\n${entries.length} entries`);
}
