/**
 * The appbay binary to re-invoke for a sub-command run as a child (`setup` runs `init` and
 * `up`; `install` runs `validate`). `process.execPath` is this compiled binary; the PATH
 * lookup is preferred so a `sudo` or a service account that installed appbay elsewhere gets
 * the same one the operator calls.
 */
import { spawnSync } from "node:child_process";

export function selfBinary(): string {
  const which = spawnSync("which", ["appbay"], { stdio: "pipe", encoding: "utf-8" });
  return which.status === 0 && which.stdout.trim() ? which.stdout.trim() : process.execPath;
}
