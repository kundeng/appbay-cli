/**
 * `appbay fixfs <app>` — fix filesystem permissions for container volumes.
 *
 * Sets ACLs for common container UIDs/GIDs so containers can read/write
 * their data directories without running as root.
 */
import { Command } from "commander";
import { discoverApps } from "@appbay/core";
import { resolveAppbayHome, resolveAppsDir } from "../utils/appbay-home.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Common container UIDs that need access
const CONTAINER_UIDS = [
  { uid: 1000, desc: "default user" },
  { uid: 911, desc: "linuxserver.io" },
  { uid: 101, desc: "nginx" },
  { uid: 1001, desc: "appbay" },
  { uid: 65534, desc: "nobody" },
];

export const fixfsCommand = new Command("fixfs")
  .description("Fix filesystem permissions for app volumes")
  .argument("<app>", "app to fix permissions for")
  .option("--uid <n>", "specific UID to grant access", parseInt)
  .option("--gid <n>", "specific GID to grant access", parseInt)
  .option("--dry-run", "show what would change")
  .action(async (app: string, options: { uid?: number; gid?: number; dryRun?: boolean }) => {
    const appsDir = resolveAppsDir();
    const discovered = await discoverApps({ appsDir });
    const target = discovered.find((a) => a.name === app);

    if (!target) {
      console.error(`App "${app}" not found.`);
      process.exit(1);
    }

    // Find volume mount paths from compose
    const services = (target.composeContent?.services || {}) as Record<string, Record<string, unknown>>;
    const bindMounts: string[] = [];

    for (const [, svc] of Object.entries(services)) {
      const volumes = svc.volumes as string[] | undefined;
      if (!volumes) continue;
      for (const vol of volumes) {
        if (typeof vol === "string") {
          const parts = vol.split(":");
          if (parts[0].startsWith("./") || parts[0].startsWith("/")) {
            const hostPath = parts[0].startsWith("./")
              ? join(target.dir, parts[0])
              : parts[0];
            bindMounts.push(hostPath);
          }
        }
      }
    }

    if (bindMounts.length === 0) {
      console.log(`No bind mounts found for "${app}". Nothing to fix.`);
      return;
    }

    const uids = options.uid
      ? [{ uid: options.uid, desc: "custom" }]
      : CONTAINER_UIDS;
    const gid = options.gid || 0;

    console.log(`Fixing permissions for "${app}":\n`);
    console.log(`  Bind mounts:`);
    for (const m of bindMounts) console.log(`    ${m}`);
    console.log(`\n  UIDs: ${uids.map((u) => `${u.uid} (${u.desc})`).join(", ")}`);

    if (options.dryRun) {
      console.log("\n  Dry run — no changes made.");
      console.log("  Would run: setfacl -R -m u:<uid>:rwX <path>");
      return;
    }

    // Check if setfacl is available
    if (spawnSync("which", ["setfacl"], { stdio: "pipe" }).status !== 0) {
      console.error("\n  Error: setfacl not found. Install acl:");
      console.error("    sudo apt install acl");
      process.exit(1);
    }

    for (const mount of bindMounts) {
      for (const { uid, desc } of uids) {
        const entry = `u:${uid}:rwX`;
        const r1 = spawnSync("setfacl", ["-R", "-m", entry, mount], { stdio: "pipe" });
        const r2 = spawnSync("setfacl", ["-R", "-d", "-m", entry, mount], { stdio: "pipe" });
        if (r1.status === 0 && r2.status === 0) {
          console.log(`  ✓ ${mount} → uid ${uid} (${desc})`);
        } else {
          console.log(`  ✗ ${mount} → uid ${uid} (${desc}) — failed`);
        }
      }
    }

    console.log("\nDone.");
  });
