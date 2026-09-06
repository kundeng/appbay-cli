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
import { createWriteStream, renameSync, chmodSync, existsSync, unlinkSync, copyFileSync } from "node:fs";
import { selfInvocation } from "../utils/self.js";
import { pullableServices } from "../utils/pullable.js";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { VERSION, compareSemver, containerCompose, discoverApps, isSystemApp } from "@appbay/core";
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
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });

  if (resp.ok) {
    const json = (await resp.json()) as { tag_name?: string };
    if (json.tag_name) return json.tag_name;
  }

  // Fallback: /releases/latest returns 404 for repos with only pre-releases.
  // List all releases and pick the most recent.
  const fallbackUrl = `https://api.github.com/repos/${REPO}/releases?per_page=1`;
  const fallbackResp = await fetch(fallbackUrl, { headers, signal: AbortSignal.timeout(30_000) });

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
    signal: AbortSignal.timeout(1_800_000),
  });

  if (!resp.ok) throw new Error(`Download failed (${resp.status}): ${url}`);
  if (!resp.body) throw new Error("Empty response body");

  const writer = createWriteStream(dest);
  await pipeline(resp.body as unknown as NodeJS.ReadableStream, writer);
  return dest;
}

/**
 * Put `newBin` at `target`, keeping the previous binary beside it as `.appbay.old` until the
 * caller has seen the new one run. Returns `restore`, which puts the old binary back, and
 * `commit`, which removes it. Copy then rename: rename(2) is atomic within one filesystem
 * and safe while the current binary runs; a rename from the temp directory fails with EXDEV
 * on a host whose /tmp is its own filesystem. Without write access the same steps run
 * through sudo.
 */
function replaceBinary(newBin: string, target: string): { restore: () => void; commit: () => void } {
  chmodSync(newBin, 0o755);
  const targetDir = dirname(target);
  const tmpTarget = join(targetDir, `.${BINARY_NAME}.new`);
  const oldTarget = join(targetDir, `.${BINARY_NAME}.old`);

  const sudo = (...argv: string[]): void => {
    const r = spawnSync("sudo", argv, { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`sudo ${argv.join(" ")} failed`);
  };
  try {
    copyFileSync(newBin, tmpTarget);
    chmodSync(tmpTarget, 0o755);
    renameSync(target, oldTarget);
    renameSync(tmpTarget, target);
    return {
      restore: () => { renameSync(oldTarget, target); },
      commit: () => { try { unlinkSync(oldTarget); } catch { /* already gone */ } },
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    try { unlinkSync(tmpTarget); } catch { /* not written */ }
    if (code !== "EACCES" && code !== "EPERM") throw err;
    try {
      sudo("mv", target, oldTarget);
      try {
        sudo("mv", newBin, target);
        sudo("chmod", "755", target);
      } catch (moveErr) {
        spawnSync("sudo", ["mv", oldTarget, target], { stdio: "inherit" });
        throw moveErr;
      }
    } catch (sudoErr) {
      const msg = sudoErr instanceof Error ? sudoErr.message : String(sudoErr);
      throw new Error(`Cannot write to ${target}. Set APPBAY_INSTALL_DIR to a writable directory, or run with sudo.\n${msg}`);
    }
    return {
      restore: () => { sudo("mv", oldTarget, target); },
      commit: () => { spawnSync("sudo", ["rm", "-f", oldTarget], { stdio: "ignore" }); },
    };
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

  // The compiled binary is `process.execPath`; under `bun run` that is bun, and replacing it
  // would be a different program's update.
  if (selfInvocation().args.length > 0) throw new Error("self-update runs from the compiled appbay binary, not from `bun run`.");
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
  const replaced = replaceBinary(tmpBin, selfPath);

  // The new binary must run before the old one is let go of.
  const verResult = spawnSync(selfPath, ["--version"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (verResult.error || verResult.status !== 0) {
    const why = verResult.error?.message || (verResult.stderr as string) || `exit ${String(verResult.status)}`;
    let restored = "the previous binary was put back";
    try { replaced.restore(); } catch (restoreErr) { restored = `and the previous binary could NOT be put back (${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)})`; }
    throw new Error(`the new binary at ${selfPath} did not run (${why}); ${restored}.`);
  }
  replaced.commit();
  const newVersion = ((verResult.stdout as string) || "").trim();

  console.log(`  Updated: ${newVersion}`);
  console.log(`\nAppbay updated to ${latestTag} successfully.`);
}

/** Pull the images of the installed system apps through their rendered compose files; the number that failed. */
async function pullSystemImages(): Promise<number> {
  const appbayHome = resolveAppbayHome();
  const rendered = (await discoverApps({ appsDir: join(appbayHome, "etc", "apps") }))
    .filter((a) => isSystemApp(a.name))
    .map((a) => ({ name: a.name, render: join(appbayHome, "var", "lib", "renders", a.name, "docker-compose.rendered.yml"), upstream: a.composePath, builds: a.appbayConfig?.builds }))
    .filter((a) => existsSync(a.render));
  if (rendered.length === 0) {
    console.log("No deployed system apps to pull for.");
    return 0;
  }
  console.log("Pulling system app images...\n");
  let failed = 0;
  for (const app of rendered) {
    const pullable = pullableServices(app.render, app.upstream, app.builds);
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
