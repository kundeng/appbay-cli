import { Command } from "commander";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolveAppbayHome, resolveAppsDir } from "../utils/appbay-home.js";

function profilesDir(): string {
  const dir = join(resolveAppbayHome(), "var", "lib", "profiles");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function snapshotApps(profileDir: string): void {
  const appsDir = resolveAppsDir();
  if (!existsSync(appsDir)) return;

  const appsSnap = join(profileDir, "apps");
  mkdirSync(appsSnap, { recursive: true });

  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const appDir = join(appsDir, entry.name);
    const snapAppDir = join(appsSnap, entry.name);
    mkdirSync(snapAppDir, { recursive: true });

    for (const file of ["appbay.yaml", ".env", ".env.local"]) {
      const src = join(appDir, file);
      if (existsSync(src)) {
        cpSync(src, join(snapAppDir, file));
      }
    }
  }
}

function restoreApps(profileDir: string): void {
  const appsDir = resolveAppsDir();
  const appsSnap = join(profileDir, "apps");
  if (!existsSync(appsSnap)) return;

  for (const entry of readdirSync(appsSnap, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const snapAppDir = join(appsSnap, entry.name);
    const appDir = join(appsDir, entry.name);

    if (!existsSync(appDir)) {
      mkdirSync(appDir, { recursive: true });
    }

    for (const file of ["appbay.yaml", ".env", ".env.local"]) {
      const src = join(snapAppDir, file);
      if (existsSync(src)) {
        cpSync(src, join(appDir, file));
      }
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += statSync(full).size;
  }
  return total;
}

export const profileCommand = new Command("profile")
  .description("Save and restore named configuration profiles")
  .addCommand(
    new Command("save")
      .description("Save current configuration as a named profile")
      .argument("<name>", "profile name")
      .option("--force", "overwrite existing profile without prompting")
      .action((name: string, options: { force?: boolean }) => {
        const dir = join(profilesDir(), name);

        if (existsSync(dir) && !options.force) {
          console.error(`Profile "${name}" already exists. Use --force to overwrite.`);
          process.exit(1);
        }

        mkdirSync(dir, { recursive: true });

        // Save metadata
        writeFileSync(
          join(dir, "profile.json"),
          JSON.stringify(
            {
              name,
              createdAt: new Date().toISOString(),
              appbayHome: resolveAppbayHome(),
            },
            null,
            2,
          ),
        );

        snapshotApps(dir);

        const appCount = existsSync(join(dir, "apps"))
          ? readdirSync(join(dir, "apps")).length
          : 0;

        console.log(`Profile "${name}" saved (${appCount} apps)`);
      }),
  )
  .addCommand(
    new Command("set")
      .description("Restore a saved profile")
      .argument("<name>", "profile name to restore")
      .action((name: string) => {
        const dir = join(profilesDir(), name);

        if (!existsSync(dir)) {
          console.error(`Profile "${name}" not found.`);
          console.error(`Available: ${listProfileNames().join(", ") || "(none)"}`);
          process.exit(1);
        }

        restoreApps(dir);

        console.log(`Profile "${name}" restored. Run \`appbay up\` to apply.`);
      }),
  )
  .addCommand(
    new Command("rm")
      .description("Delete a saved profile")
      .argument("<name>", "profile name to delete")
      .action((name: string) => {
        const dir = join(profilesDir(), name);

        if (!existsSync(dir)) {
          console.error(`Profile "${name}" not found.`);
          process.exit(1);
        }

        rmSync(dir, { recursive: true, force: true });
        console.log(`Profile "${name}" deleted.`);
      }),
  )
  .addCommand(
    new Command("ls")
      .description("List saved profiles")
      .option("--json", "output as JSON")
      .action((options: { json?: boolean }) => {
        const profiles = listProfiles();

        if (profiles.length === 0) {
          console.log("No profiles saved. Create one with: appbay profile save <name>");
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(profiles, null, 2));
          return;
        }

        for (const p of profiles) {
          console.log(`  ${p.name.padEnd(20)} ${String(p.apps).padStart(3)} apps  ${p.size.padStart(8)}  ${p.createdAt}`);
        }
      }),
  );

function listProfileNames(): string[] {
  const dir = profilesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function listProfiles(): Array<{ name: string; apps: number; size: string; createdAt: string }> {
  const dir = profilesDir();
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const pDir = join(dir, e.name);
      const meta = existsSync(join(pDir, "profile.json"))
        ? JSON.parse(readFileSync(join(pDir, "profile.json"), "utf-8"))
        : {};
      const appsDir = join(pDir, "apps");
      const apps = existsSync(appsDir) ? readdirSync(appsDir).length : 0;
      return {
        name: e.name,
        apps,
        size: formatSize(dirSize(pDir)),
        createdAt: meta.createdAt ? new Date(meta.createdAt).toLocaleDateString() : "unknown",
      };
    });
}

profileCommand.action(() => {
  profileCommand.commands.find((c) => c.name() === "ls")?.parse(["node", "ls"]);
});
