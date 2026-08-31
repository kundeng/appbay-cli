/**
 * `keepassxc-cli` invocation — the one place that runs it, and it never uses a shell.
 *
 * 🚨 THIS EXISTS BECAUSE ARGV IS WORLD-READABLE. The six call sites this replaces each
 * composed a string like:
 *
 *     echo '<master-password>' | keepassxc-cli show --quiet '<db>' '<entry>'
 *
 * and handed it to `exec`, which runs `/bin/sh -c '<that string>'`. The quoting was
 * correct, so this was never an injection bug — it was a disclosure bug, which is worse
 * because it looks fine. The composed string is the *argv of the shell process*, so the
 * master password sat in `/proc/<pid>/cmdline` — readable by any local user for the life
 * of the process — and in every auditd `execve` record. Two of the six also carried the
 * stored secret value, not just the master.
 *
 * `apps/cli/src/commands/secrets.ts` already states the rule for exactly this reason:
 * "it is NOT fine for a configuration-management run seeding real credentials onto a
 * shared host." That is the mode this project deploys in.
 *
 * ⇒ `execFile` with an argv array and no `shell` option. Nothing is composed, no shell is
 * spawned, and the secret travels down the child's stdin, which is not world-readable.
 * RFC-001 §3.1.
 *
 * ⚠️ Newlines are load-bearing. `keepassxc-cli` reads a *line* per prompt, and the
 * `echo '…'` this replaces supplied the terminator for free — pipe a bare password with no
 * newline and the tool blocks until the timeout instead of failing. Use `stdinLines()`,
 * which terminates every line including the last. Measured against keepassxc-cli 2.6.6:
 * `db-create`, `add -p` and `edit -p` all accept a trailing newline, and a secret ending in
 * whitespace round-trips byte-exact.
 */

import { execFile } from "node:child_process";

const BIN = "keepassxc-cli";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 1024 * 1024;

export interface KeepassxcResult {
  stdout: string;
  stderr: string;
}

/**
 * Build a stdin payload for `keepassxc-cli`: one value per prompt, each terminated.
 *
 * `stdinLines(password)` → `"pw\n"` — one prompt, e.g. `show`, `mkdir`, `rm`, `ls`.
 * `stdinLines(password, value)` → `"pw\nvalue\n"` — two prompts, e.g. `add -p` and
 * `edit -p`, which read line 1 as the database password and line 2 as the entry's.
 * `stdinLines(pw, pw)` → the `db-create --set-password` case, which prompts twice: enter,
 * then repeat.
 */
export function stdinLines(...values: string[]): string {
  return values.map((v) => `${v}\n`).join("");
}

/**
 * Run `keepassxc-cli` with an argv array, writing `stdin` to the child.
 *
 * No shell, so no argument needs escaping and none of them can be re-parsed. Rejects on a
 * non-zero exit or timeout, matching the `execAsync` behaviour the call sites expect.
 */
export function runKeepassxc(
  args: string[],
  stdin = "",
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<KeepassxcResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      BIN,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      },
    );

    // The child can exit before reading stdin — a wrong password, a missing database, a
    // bad argument. Writing to its closed pipe raises EPIPE, which would surface as an
    // unhandled error event and mask the real exit status the callback is about to
    // report. Swallow it here and let the callback speak.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
}
