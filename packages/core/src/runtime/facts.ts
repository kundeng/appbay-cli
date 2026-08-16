/**
 * Runtime facts detection for app operators.
 *
 * Probes the host environment to populate `RuntimeFacts` — GPU availability,
 * Docker/Compose versions, OS info, disk capacity, and operator identity.
 *
 * Design notes:
 * - Detection is IO-bound and synchronous for simplicity (runs once at startup).
 * - Returns partial facts on probe failure (missing GPU = available: false).
 * - Operator ID is persisted to a file so it survives restarts.
 * - All probes use `execSync` with stdio: pipe to suppress output on failure.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statfsSync, readdirSync } from "node:fs";
import { platform, arch, release } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeFacts, GpuFacts } from "../schemas/runtime-facts.js";
import { containerBin } from "./container-runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a command (binary + args) and return trimmed stdout, or null on failure.
 * Never throws — callers handle null as "not available".
 */
function tryExec(binary: string, args: string[]): string | null {
  const result = spawnSync(binary, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5000,
  });
  if (result.status !== 0 || result.error) return null;
  return (result.stdout as string).trim() || null;
}

/**
 * Parse a version string like "Docker version 24.0.7, build afdd53b4e3"
 * down to just "24.0.7".
 */
export function extractVersion(raw: string | null, pattern: RegExp): string {
  if (!raw) return "unknown";
  const match = raw.match(pattern);
  return match?.[1] ?? "unknown";
}

// ---------------------------------------------------------------------------
// GPU Detection
// ---------------------------------------------------------------------------

/**
 * Whether this host has a CDI spec a container runtime can act on.
 *
 * 🚨 THIS USED TO REQUIRE `nvidia-ctk` AND ONLY LOOK IN /var/run/cdi, AND BOTH WERE WRONG.
 * `nvidia-ctk` GENERATES specs; the RUNTIME consumes them. A host whose spec was generated
 * elsewhere — by a containerised toolkit, by the distro, by a previous install — supports CDI
 * perfectly with no toolkit binary present. And the spec lives in one of TWO standard
 * directories: /etc/cdi for persistent specs, /var/run/cdi for generated ones. Checking only
 * the second missed the common case.
 *
 * Measured on the workstation this was found on: driver 580.82.09, NO nvidia-ctk,
 * NO nvidia-container-runtime, a spec at /etc/cdi/nvidia.yaml, and
 * `docker run --device nvidia.com/gpu=all … nvidia-smi -L` listing the GPU. Detection said
 * cdiSupported=false, so the trait fell through to the `nvidia` variant, which emits
 * `driver: nvidia` reservations that need the container runtime that is not installed. A
 * working host would have been told its GPU could not be used.
 *
 * ⚠️ Presence of a spec is necessary, not sufficient: the runtime must also speak CDI
 * (Docker >= 25, Podman >= 4.1). Both are far below the floors `doctor` already enforces, so
 * that is not re-checked here.
 */
function hasCdiSpec(): boolean {
  for (const dir of ["/etc/cdi", "/var/run/cdi"]) {
    try {
      // A directory with no spec in it is not support — an empty /etc/cdi exists on plenty of
      // hosts that have never seen a GPU.
      if (readdirSync(dir).some((f) => f.endsWith(".yaml") || f.endsWith(".json"))) return true;
    } catch {
      // Missing or unreadable directory: not an error, just not this one.
    }
  }
  return false;
}

function detectGpu(): GpuFacts {
  // NVIDIA: try nvidia-smi first
  const nvidiaSmiOut = tryExec("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
  if (nvidiaSmiOut) {
    const devices = nvidiaSmiOut.split("\n").filter(Boolean);
    const cdiSupported = hasCdiSpec();
    return {
      available: true,
      vendor: "nvidia",
      cdiSupported,
      devices: devices.map((d, i) => `nvidia.com/gpu=${i}`),
    };
  }

  // AMD ROCm: try rocm-smi
  const rocmSmiOut = tryExec("rocm-smi", ["--showproductname", "--csv"]);
  if (rocmSmiOut) {
    return {
      available: true,
      vendor: "amd",
      cdiSupported: false,
      devices: [],
    };
  }

  // Intel GPU: check for /dev/dri render nodes (no process spawn needed)
  if (existsSync("/dev/dri/renderD128")) {
    return {
      available: true,
      vendor: "intel",
      cdiSupported: false,
      devices: ["/dev/dri/renderD128"],
    };
  }

  return { available: false, cdiSupported: false };
}

// ---------------------------------------------------------------------------
// Docker Detection
// ---------------------------------------------------------------------------

function detectDocker(): { version: string; composeVersion: string; socketPath: string } {
  const dockerRaw = tryExec(containerBin(), ["--version"]);
  // "Docker version 24.0.7, build afdd53b4e3" → "24.0.7"
  const version = extractVersion(dockerRaw, /Docker version ([0-9]+\.[0-9]+\.[0-9]+)/);

  const composeRaw = tryExec(containerBin(), ["compose", "version", "--short"]);
  // "v2.23.3" or "2.23.3"
  const composeVersion = composeRaw?.replace(/^v/, "") ?? "unknown";

  // Prefer $DOCKER_HOST socket path, fall back to default
  const socketPath =
    process.env.DOCKER_HOST?.replace("unix://", "") ??
    (existsSync("/var/run/docker.sock") ? "/var/run/docker.sock" : "/run/docker.sock");

  return { version, composeVersion, socketPath };
}

// ---------------------------------------------------------------------------
// OS Detection
// ---------------------------------------------------------------------------

function detectOs(): { platform: string; arch: string; version: string } {
  return {
    platform: platform(),
    arch: arch(),
    version: release(),
  };
}

// ---------------------------------------------------------------------------
// Disk Detection
// ---------------------------------------------------------------------------

function detectDisk(path: string): { availableGb: number; totalGb: number } {
  try {
    const stats = statfsSync(path);
    const blockSize = stats.bsize;
    const availableGb = (stats.bavail * blockSize) / 1_073_741_824;
    const totalGb = (stats.blocks * blockSize) / 1_073_741_824;
    return {
      availableGb: Math.round(availableGb * 10) / 10,
      totalGb: Math.round(totalGb * 10) / 10,
    };
  } catch {
    return { availableGb: 0, totalGb: 0 };
  }
}

// ---------------------------------------------------------------------------
// Operator ID
// ---------------------------------------------------------------------------

/**
 * Load or generate a stable operator ID.
 * Persisted to `$stateDir/operator-id` so it survives restarts.
 */
function resolveOperatorId(stateDir: string): string {
  const idFile = join(stateDir, "operator-id");
  if (existsSync(idFile)) {
    try {
      const id = readFileSync(idFile, "utf-8").trim();
      if (id.length > 0) return id;
    } catch {
      // Fall through to generate
    }
  }

  const id = randomUUID();
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(idFile, id, "utf-8");
  } catch {
    // If we can't persist, use an ephemeral ID
  }
  return id;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DetectRuntimeFactsOptions {
  /** Directory to persist the operator ID (e.g., `$APPBAY_HOME/var/lib/state`). */
  stateDir: string;
  /** Path used for disk space reporting (defaults to stateDir). */
  diskPath?: string;
}

/**
 * Probe the host environment and return a `RuntimeFacts` object.
 *
 * Probes are best-effort: failures populate with safe defaults rather than
 * throwing. Callers should treat `docker.version === "unknown"` as a signal
 * that Docker is not available.
 */
export function detectRuntimeFacts(options: DetectRuntimeFactsOptions): RuntimeFacts {
  const { stateDir, diskPath = stateDir } = options;

  const gpu = detectGpu();
  const docker = detectDocker();
  const os = detectOs();
  const disk = detectDisk(diskPath);
  const operatorId = resolveOperatorId(stateDir);

  return { gpu, docker, os, disk, operatorId };
}
