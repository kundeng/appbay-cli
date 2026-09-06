/**
 * How to re-invoke this CLI for a sub-command run as a child (`setup` runs `init` and `up`;
 * `install` runs `validate`). A `bun build --compile` executable is `process.execPath`
 * itself. Under `bun run src/index.ts` (dev) `execPath` is bun and the script is
 * `process.argv[1]`, so the invocation is the pair; a PATH lookup could only pick a binary
 * other than the one running.
 */
import { basename } from "node:path";

export function selfInvocation(): { bin: string; args: string[] } {
  const bin = process.execPath;
  const runner = basename(bin).replace(/\.exe$/, "");
  if ((runner === "bun" || runner === "node") && process.argv[1]) return { bin, args: [process.argv[1]] };
  return { bin, args: [] };
}
