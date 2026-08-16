/** Local AppBay control-plane account recovery. */

import { Command } from "commander";
import { Database } from "bun:sqlite";
import { ControlPlaneUserStore, hashControlPlanePassword } from "@appbay/core";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { resolveAppbayHome } from "../utils/appbay-home.js";

async function readPasswordFromStdin(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  const password = value.replace(/[\r\n]+$/, "");
  if (!password) throw new Error("No password received on standard input.");
  return password;
}

const resetPasswordCommand = new Command("reset-password")
  .description("Reset the password for signing in to APPBAY ITSELF (control-plane account, etc/control-plane/users.yaml). Not an edge user — see `appbay edge users`.")
  .argument("<username>", "local AppBay username")
  .option("--generate", "generate a password instead of reading it from standard input")
  .option("--password-stdin", "read the new password from standard input")
  .option("--reveal", "print a generated password once")
  .option("--json", "emit machine-readable status without a password")
  .action(async (username: string, options: { generate?: boolean; passwordStdin?: boolean; reveal?: boolean; json?: boolean }) => {
    if (Boolean(options.generate) === Boolean(options.passwordStdin)) {
      throw new Error("Choose exactly one of --generate or --password-stdin.");
    }
    if (options.reveal && !options.generate) {
      throw new Error("--reveal is only valid with --generate.");
    }

    const password = options.generate ? randomBytes(24).toString("base64url") : await readPasswordFromStdin();
    const appbayHome = resolveAppbayHome();
    const db = new Database(join(appbayHome, "var", "lib", "appbay.db"), { strict: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const store = new ControlPlaneUserStore(appbayHome);
      let document = await store.read();
      if (!document) {
        const legacyUsers = db.query<{
          id: string;
          username: string;
          password_hash: string;
          created_at: string;
        }, []>("SELECT id, username, password_hash, created_at FROM users ORDER BY created_at").all();
        if (legacyUsers.length === 0) {
          throw new Error(`Local AppBay user '${username}' not found.`);
        }
        document = {
          version: 1,
          users: legacyUsers.map((user) => ({
            id: user.id,
            username: user.username,
            passwordHash: user.password_hash,
            status: "active" as const,
            createdAt: user.created_at,
            updatedAt: user.created_at,
          })),
        };
        await store.write(document);
      }

      const existing = document.users.find((user) => user.username === username);
      if (!existing) throw new Error(`Local AppBay user '${username}' not found.`);
      const passwordHash = hashControlPlanePassword(password);
      const changed = await store.replacePasswordHash(username, passwordHash);

      // 🚨 THE FILE IS ALREADY COMMITTED. Everything below touches the DISPOSABLE
      // SQLite mirror, so a failure here must NOT be reported as a failed reset and
      // must NOT roll the file back (S25 design, save_control_plane_users step 6).
      // Throwing would tell an operator the reset failed while the new password is
      // live — they retry, or worse, conclude they are locked out and reinstall.
      let invalidatedSessions = 0;
      let staleCache: string | null = null;
      try {
        const reset = db.transaction(() => {
          db.query(
            `INSERT INTO users (id, username, password_hash, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               username = excluded.username,
               password_hash = excluded.password_hash`,
          ).run(changed.id, changed.username, changed.passwordHash, changed.createdAt);
          return db.query("DELETE FROM sessions WHERE user_id = ?").run(changed.id).changes;
        });
        invalidatedSessions = reset();
      } catch (error) {
        staleCache = error instanceof Error ? error.message : String(error);
      }

      const result = { changed: true, username, invalidatedSessions, staleCache };
      if (options.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`Password reset for local AppBay user: ${username}`);
        if (staleCache) {
          // ⚠️ Sessions were NOT invalidated. Say so plainly — an operator resetting a
          // password usually intends to lock someone out, and a silent partial success
          // leaves the old session alive.
          console.warn(`  ⚠ Password file updated, but the local cache did not: ${staleCache}`);
          console.warn(`    The new password is live. Existing sessions were NOT invalidated.`);
          console.warn(`    Run 'appbay server restart' to rebuild the cache from the file.`);
        } else {
          console.log(`  Invalidated sessions: ${invalidatedSessions}`);
        }
        if (options.reveal) console.log(`  New password: ${password}`);
      }
    } finally {
      db.close();
    }
  });

export const adminCommand = new Command("admin")
  .description("Manage accounts that sign in to AppBay itself (not to deployed apps)")
  .addCommand(resetPasswordCommand);
