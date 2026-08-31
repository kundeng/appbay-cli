/**
 * Carry legacy control-plane accounts into the edge identity store — RFC-001 §1.5 (task 5.4).
 *
 * ⭐ WHY A MIGRATION AND NOT JUST A DELETION. §1 removes AppBay's own accounts, and an
 * installation that had them would otherwise wake up with no way in: the file it authenticated
 * against is no longer read, and the edge store it now authenticates against has never heard of
 * those people. Deleting the concept without moving the accounts strands the operator.
 *
 * 🚨 THE PASSWORDS CANNOT COME WITH THEM, AND NOTHING HERE PRETENDS OTHERWISE.
 * `users.yaml` stored `salt:scrypt-hash`; Caddy Security stores bcrypt `$2a$10$…`. A hash
 * cannot be converted into another scheme's hash — that is the point of hashing — so each
 * imported account gets a NEWLY GENERATED password which is printed once. Silently importing
 * accounts whose old passwords appear to still work would be the cruellest possible outcome:
 * the operator would try the password they know, be refused, and have no reason to suspect the
 * migration.
 *
 * ⚠️ IMPORTED ACCOUNTS GET `authp/admin`. They administered AppBay before, and the control
 * plane's edge route admits that role only. Importing them as ordinary users would move every
 * account across and leave none of them able to sign in — a migration that reports success and
 * strands the operator anyway.
 */

import { readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { EdgeIdentityStore } from "./edge-identity-service.js";

/** Where the retired control-plane account file lived, relative to `$APPBAY_HOME`. */
export const LEGACY_CONTROL_PLANE_REL = join("etc", "control-plane", "users.yaml");

/** An account that made it across, with the password the operator now needs. */
export interface ImportedAccount {
  username: string;
  /** Newly generated — the old one could not travel. Printed once and never stored. */
  password: string;
}

/** An account that did not make it across, and why. */
export interface SkippedAccount {
  username: string;
  reason: string;
}

export interface ControlPlaneImportReport {
  /** False when there is no legacy file — the normal case, and not an error. */
  found: boolean;
  imported: ImportedAccount[];
  skipped: SkippedAccount[];
  /** Where the legacy file was moved to, once every account was dealt with. */
  archivedTo: string | null;
}

/** Shape actually read out of the legacy file. Deliberately narrow. */
interface LegacyUser {
  username: string;
  status?: string;
}

/**
 * Read the legacy file, tolerating anything but a missing username.
 *
 * ⚠️ Parsed loosely on purpose. The schema module that validated this file is deleted, and
 * re-adding it to read a file being retired would resurrect the concept. A record with no
 * usable username is skipped rather than throwing, because one malformed entry must not block
 * the migration of everyone else.
 */
function readLegacyUsers(text: string): LegacyUser[] {
  const parsed = parseYaml(text) as unknown;
  if (!parsed || typeof parsed !== "object") return [];
  const users = (parsed as { users?: unknown }).users;
  if (!Array.isArray(users)) return [];
  return users
    .filter((u): u is Record<string, unknown> => !!u && typeof u === "object")
    .map((u) => ({
      username: typeof u.username === "string" ? u.username.trim() : "",
      status: typeof u.status === "string" ? u.status : undefined,
    }));
}

function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Import every active legacy account into the edge identity store.
 *
 * Idempotent by construction: the legacy file is archived once every account has been dealt
 * with, so a second run finds nothing. If ANY account fails, the file is left in place — a
 * migration that half-succeeded and then hid its own input is unrecoverable.
 */
export async function importControlPlaneAccounts(
  appbayHome: string,
  store: EdgeIdentityStore = new EdgeIdentityStore(appbayHome),
): Promise<ControlPlaneImportReport> {
  const legacyPath = join(appbayHome, LEGACY_CONTROL_PLANE_REL);
  if (!existsSync(legacyPath)) {
    return { found: false, imported: [], skipped: [], archivedTo: null };
  }

  const legacy = readLegacyUsers(await readFile(legacyPath, "utf-8"));
  const existing = new Set((await store.read()).users.map((u) => u.username));

  const imported: ImportedAccount[] = [];
  const skipped: SkippedAccount[] = [];

  for (const user of legacy) {
    if (!user.username) {
      skipped.push({ username: "(unnamed)", reason: "the record has no username" });
      continue;
    }
    if (user.status && user.status !== "active") {
      // Importing a disabled account would re-enable it, because the edge store has no
      // disabled state — a migration must not restore access someone deliberately removed.
      skipped.push({ username: user.username, reason: `status is "${user.status}", not active` });
      continue;
    }
    if (existing.has(user.username)) {
      skipped.push({ username: user.username, reason: "already exists at the edge" });
      continue;
    }

    const password = generatePassword();
    await store.create({
      username: user.username,
      email: `${user.username}@localdomain.local`,
      password,
      roles: ["authp/admin"],
    });
    existing.add(user.username);
    imported.push({ username: user.username, password });
  }

  // Archive only when nothing was left unresolved by an ERROR. "Already exists" and "not
  // active" are resolved outcomes; a record we could not name is not, and keeping the file
  // is the only way anyone could go back and look at it.
  const unresolved = skipped.some((s) => s.username === "(unnamed)");
  let archivedTo: string | null = null;
  if (!unresolved) {
    archivedTo = `${legacyPath}.imported`;
    await rename(legacyPath, archivedTo);
  }

  return { found: true, imported, skipped, archivedTo };
}
