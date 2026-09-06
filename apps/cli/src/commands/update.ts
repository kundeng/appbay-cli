/**
 * `appbay update` — self-update CLI and system app images.
 *
 * Subcommands (via --check / --system-only flags) or bare invocation:
 *   appbay update               Download and install the latest CLI binary
 *   appbay update --check       Print current vs latest, do not install
 *   appbay update --system-only Pull system app Docker images only
 */
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { createWriteStream, renameSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { VERSION, compareSemver, containerCompose, discoverApps, isSystemApp } from "@appbay/core";
import { readFileSync, copyFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { resolveAppbayHome } from "../utils/appbay-home.js";

const REPO = "kundeng/appbay-cli";
const BINARY_NAME = "appbay";


/* ── Helpers ───────────────────────────────────────────────────────────────── */

function detectPlatform(): string {
  const platform = process.platform;
  const arch = process.arch;

  const osTag = platform === "darwin" ? "macos" : "linux";
  const archTag = arch === "arm64" ? "arm64" : "x64";

  return `${osTag}-${archTag}`;
}

/** Fetch the latest published release tag from GitHub Releases API.
 *
 * Override with APPBAY_UPDATE_VERSION env var for testing (skips GitHub API).
 * Falls back to listing all releases if /releases/latest returns 404
 * (happens when only pre-releases exist).
 */
async function fetchLatestVersion(): Promise<string> {
  // Allow override for CI/local testing: APPBAY_UPDATE_VERSION=0.1.1
  if (process.env.APPBAY_UPDATE_VERSION) {
    return process.env.APPBAY_UPDATE_VERSION;
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": `appbay-cli/${VERSION}`,
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
  }

  const url = `https://api.github.com/repos/${REPO}/releases/latest`;
  const resp = await fetch(url, { headers });

  if (resp.ok) {
    const json = (await resp.json()) as { tag_name?: string };
    if (json.tag_name) return json.tag_name;
  }

  // Fallback: /releases/latest returns 404 for repos with only pre-releases.
  // List all releases and pick the most recent.
  const fallbackUrl = `https://api.github.com/repos/${REPO}/releases?per_page=1`;
  const fallbackResp = await fetch(fallbackUrl, { headers });

  if (!fallbackResp.ok) {
    throw new Error(`GitHub API error ${fallbackResp.status}: ${await fallbackResp.text()}`);
  }

  const releases = (await fallbackResp.json()) as Array<{ tag_name?: string }>;
  const tag = releases[0]?.tag_name;
  if (!tag) throw new Error("No releases found. Check https://github.com/kundeng/appbay-cli/releases");
  return tag;
}

/** Download a URL to a temp file, return its path. */
async function downloadToTemp(url: string, suffix: string): Promise<string> {
  const dest = join(tmpdir(), `${BINARY_NAME}-update-${Date.now()}${suffix}`);
  const resp = await fetch(url, {
    headers: { "User-Agent": `appbay-cli/${VERSION}` },
    redirect: "follow",
  });

  if (!resp.ok) throw new Error(`Download failed (${resp.status}): ${url}`);
  if (!resp.body) throw new Error("Empty response body");

  const writer = createWriteStream(dest);
  await pipeline(resp.body as unknown as NodeJS.ReadableStream, writer);
  return dest;
}

/** Atomically replace the running binary with newBin. Falls back to sudo. */
function replaceBinary(newBin: string, target: string): void {
  chmodSync(newBin, 0o755);
  const targetDir = dirname(target);
  const tmpTarget = join(targetDir, `.${BINARY_NAME}.new`);

  try {
    // Copy into the target's own directory, then rename over it: rename(2) is atomic within
    // one filesystem and safe while the current binary runs; a rename from the temp
    // directory would fail with EXDEV on any host whose /tmp is its own filesystem.
    copyFileSync(newBin, tmpTarget);
    chmodSync(tmpTarget, 0o755);
    renameSync(tmpTarget, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw err;
    // No write access; try via sudo
    try {
      const mv = spawnSync("sudo", ["mv", newBin, target], { stdio: "inherit" });
      const chmod = mv.status === 0
        ? spawnSync("sudo", ["chmod", "755", target], { stdio: "inherit" })
        : mv;
      if (mv.status !== 0 || chmod.status !== 0) throw new Error("sudo command failed");
    } catch (sudoErr) {
      const msg = sudoErr instanceof Error ? sudoErr.message : String(sudoErr);
      throw new Error(
        `Cannot write to ${target}. Set APPBAY_INSTALL_DIR to a writable directory, or run with sudo.\n${msg}`,
      );
    }
  }
}

/* ── Suboperations ─────────────────────────────────────────────────────────── */

async function checkForUpdates(): Promise<void> {
  console.log(`Current version: ${VERSION}\n`);
  console.log("Checking for updates...");

  const latestTag = await fetchLatestVersion();
  const latest = latestTag.replace(/^v/, "");
  const current = VERSION.replace(/^v/, "");

  if (compareSemver(latest, current) > 0) {
    console.log(`  New version available: ${latestTag}`);
    console.log(`  Run "appbay update" to install.`);
  } else {
    console.log(`  You are up to date (${VERSION}).`);
  }
}

async function selfUpdate(): Promise<void> {
  console.log(`Current version: ${VERSION}\n`);

  // Determine where this binary lives
  const selfPath = process.execPath;
  if (!existsSync(selfPath)) {
    throw new Error(`Cannot locate running binary at: ${selfPath}`);
  }

  console.log("Checking for updates...");
  const latestTag = await fetchLatestVersion();
  const latest = latestTag.replace(/^v/, "");
  const current = VERSION.replace(/^v/, "");

  if (compareSemver(latest, current) <= 0) {
    console.log(`  Already up to date (${VERSION}).`);
    return;
  }

  const platform = detectPlatform();
  const assetName = `${BINARY_NAME}-${platform}`;
  // Allow override for CI/local testing: APPBAY_UPDATE_URL=http://host/appbay
  const downloadUrl =
    process.env.APPBAY_UPDATE_URL ??
    `https://github.com/${REPO}/releases/download/${latestTag}/${assetName}`;

  console.log(`  Downloading ${assetName} ${latestTag}...`);
  const tmpBin = await downloadToTemp(downloadUrl, "");

  console.log(`  Installing to ${selfPath}...`);
  replaceBinary(tmpBin, selfPath);

  // Verify
  const verResult = spawnSync(selfPath, ["--version"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (verResult.error || verResult.status !== 0) {
    throw new Error(`the new binary at ${selfPath} did not run: ${verResult.error?.message ?? (verResult.stderr as string) ?? `exit ${String(verResult.status)}`}`);
  }
  const newVersion = ((verResult.stdout as string) || "").trim();

  console.log(`  Updated: ${newVersion}`);
  console.log(`\nAppbay updated to ${latestTag} successfully.`);
}

/** Pull the images of the installed system apps through their rendered compose files; the number that failed. */
async function pullSystemImages(): Promise<number> {
  const appbayHome = resolveAppbayHome();
  const rendered = (await discoverApps({ appsDir: join(appbayHome, "etc", "apps") }))
    .filter((a) => isSystemApp(a.name))
    .map((a) => ({ name: a.name, render: join(appbayHome, "var", "lib", "renders", a.name, "docker-compose.rendered.yml") }))
    .filter((a) => existsSync(a.render));
  if (rendered.length === 0) {
    console.log("No deployed system apps to pull for.");
    return 0;
  }
  console.log("Pulling system app images...\n");
  let failed = 0;
  for (const app of rendered) {
    // A service with `build:` (the caddy edge) is built here, never pulled: compose asks the
    // registry for its local tag and fails. Only the pullable services are named.
    const services = (parseYaml(readFileSync(app.render, "utf-8")) as { services?: Record<string, { build?: unknown }> }).services ?? {};
    const pullable = Object.entries(services).filter(([, svc]) => svc.build === undefined).map(([name]) => name);
    if (pullable.length === 0) { console.log(`  ${app.name}... nothing to pull (built locally)`); continue; }
    process.stdout.write(`  ${app.name}...`);
    const pull = containerCompose(["pull", ...pullable], app.render, undefined, appbayHome);
    if (pull.exitCode === 0) {
      process.stdout.write(" done\n");
    } else {
      failed++;
      process.stdout.write(` FAILED (${pull.output.trim().split("\n").pop()})\n`);
    }
  }
  return failed;
}

/* ── Command ───────────────────────────────────────────────────────────────── */

export const updateCommand = new Command("update")
  .description("Update Appbay CLI binary and system app images")
  .option("--check", "check for updates without installing")
  .option("--system-only", "only pull system app Docker images")
  .action(async (options: { check?: boolean; systemOnly?: boolean }) => {
    try {
      if (options.check) {
        await checkForUpdates();
        return;
      }

      if (options.systemOnly) {
        const failed = await pullSystemImages();
        if (failed > 0) {
          console.error(`\n${String(failed)} image pull(s) failed.`);
          process.exit(1);
        }
        return;
      }

      // Default: self-update CLI, then offer to pull images
      await selfUpdate();

      console.log("\nTo pull the system app images as well: appbay update --system-only");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nUpdate failed: ${msg}`);
      process.exit(1);
    }
  });
