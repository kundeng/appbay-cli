/**
 * Shared CLI execution utilities.
 */

import { spawnSync } from "node:child_process";

/**
 * Try to execute a binary. Returns trimmed stdout on success, null on failure.
 */
export function tryExec(binary: string, args: string[]): string | null {
  const result = spawnSync(binary, args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  if (result.status !== 0 || result.error) return null;
  return (result.stdout as string).trim() || null;
}

/**
 * Compare two semver strings (e.g., "1.2.3" vs "v1.3.0").
 * Strips leading "v" prefix. Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}
