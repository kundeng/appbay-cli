/**
 * `appbay rebuild-cache` command.
 *
 * Regenerates the SQLite metadata cache from filesystem state. This is the
 * recovery path when the database is deleted or corrupted.
 *
 * The filesystem is always the source of truth. This command:
 *   1. Scans `$APPBAY_HOME/etc/apps/` for app definitions
 *   2. Reads `$APPBAY_HOME/var/lib/state/generated-values.yaml`
 *   3. Clears and repopulates the SQLite cache tables
 *   4. Reports what was synced
 *
 * See agents.md "Filesystem-first philosophy" for details.
 */

import { Command } from "commander";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createDatabase, CacheStore } from "@appbay/db";
import { resolveAppbayHome } from "../utils/appbay-home.js";

export const rebuildCacheCommand = new Command("rebuild-cache")
  .description("Regenerate SQLite cache from filesystem state")
  .action(async () => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");
    const stateDir = join(appbayHome, "var", "lib", "state");
    const dbPath = join(appbayHome, "var", "lib", "appbay.db");

    // Ensure the database directory exists
    const dbDir = join(appbayHome, "var", "lib");
    mkdirSync(dbDir, { recursive: true });

    console.log(`Rebuilding cache from ${appbayHome}...`);
    console.log();

    let db;
    try {
      db = createDatabase(dbPath);
    } catch (err) {
      // better-sqlite3 native module may not work in bun-compiled binaries
      console.error("Failed to open SQLite database.");
      console.error("This is a known limitation when running the CLI as a compiled binary.");
      console.error("");
      console.error("Workarounds:");
      console.error("  1. Run via Node.js: npx tsx apps/cli/src/index.ts rebuild-cache");
      console.error("  2. Use the web UI: the server handles SQLite natively");
      console.error("  3. Delete the DB file and the server will recreate it on startup:");
      console.error(`     rm ${dbPath}`);
      process.exit(1);
    }
    const cache = new CacheStore(db);

    const result = await cache.rebuild({ appsDir, stateDir });

    // Report results
    console.log("Rebuild complete:");
    console.log(`  Apps synced:             ${result.appsSync}`);
    console.log(`  Generated values synced: ${result.generatedValuesSync}`);

    if (result.errors.length > 0) {
      console.log();
      console.log("Errors:");
      for (const error of result.errors) {
        console.log(`  - ${error}`);
      }
    }

    console.log();
    console.log(`Database: ${dbPath}`);
  });
