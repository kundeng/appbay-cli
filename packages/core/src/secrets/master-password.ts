/**
 * The one master password, and the one place that resolves it — RFC-001 §2.2.
 *
 * 🚨 THERE WERE FOUR RESOLVERS, IN TWO DUPLICATED PAIRS. `vault.ts` and `vault-service.ts`
 * each had a two-tier vault resolver; `keepass.ts` and `vault-service.ts` each had a
 * four-tier KeePass ladder. Within each pair the logic was identical apart from whether
 * `appbayHome` arrived as an argument or was re-derived from the environment — so the same
 * question had two answers that could drift, and two of them resolved the home differently
 * from the CLI's own `resolveAppbayHome()`.
 *
 * One password now opens whichever store the installation uses. The backend is a deployment
 * choice; the credential is not.
 *
 * Resolution order:
 *   1. `APPBAY_MASTER_PASSWORD`
 *   2. `$APPBAY_HOME/var/lib/secrets/master-password`
 *   3. legacy env  — `APPBAY_VAULT_PASSWORD`, then `APPBAY_KEEPASS_PASSWORD`
 *   4. legacy files — `etc/vault-password`, then `etc/kdbx-password`
 *   5. generate and persist, only when the caller asks for it
 *
 * ⚠️ Steps 3 and 4 are a MIGRATION SHIM, not the design. RFC-001 §2 puts the credential at
 * `var/lib/secrets/master-password`; the legacy paths are read so an existing install keeps
 * working across the upgrade, and they are due for removal one release later.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the master password lives from RFC-001 §2 onward, relative to APPBAY_HOME. */
export const MASTER_PASSWORD_REL = join("var", "lib", "secrets", "master-password");

/** Pre-§2 locations, read for one release so an existing install survives the upgrade. */
const LEGACY_PASSWORD_FILES = [
  join("etc", "vault-password"),
  join("etc", "kdbx-password"),
] as const;

/** Pre-§2 environment variables, in the precedence the old resolvers used. */
const LEGACY_ENV_VARS = ["APPBAY_VAULT_PASSWORD", "APPBAY_KEEPASS_PASSWORD"] as const;

/**
 * Fall back to the same home the old provider-side resolvers assumed.
 *
 * ⚠️ `keepass.ts` and `vault.ts` both did `process.env.APPBAY_HOME ?? join(HOME, ".appbay")`
 * inline, which is NOT what the CLI's `resolveAppbayHome()` computes — it also consults
 * `/etc/appbay/config` and `~/.config/appbay/home`. Callers that know the home should pass
 * it; this exists so the secret providers, which are handed a URI and nothing else, behave
 * as they did rather than changing two questions at once.
 */
function defaultHome(): string {
  return process.env.APPBAY_HOME ?? join(homedir() || "/root", ".appbay");
}

/** Read a password file, returning null when it is absent or blank. */
function readPasswordFile(path: string): string | null {
  try {
    const value = readFileSync(path, "utf-8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * 🚨 Refuse to collapse two DIFFERENT legacy passwords into one.
 *
 * `etc/vault-password` and `etc/kdbx-password` were independent: vault init generated one
 * and `initKdbx` generated its own `randomBytes(24)` when no env var was set, so an install
 * that used both backends holds two unrelated credentials. Picking either one silently makes
 * the other store unopenable — the data is still there and nothing can read it, which is the
 * worst shape a secrets bug can take.
 */
function assertLegacyFilesAgree(appbayHome: string): void {
  const present = LEGACY_PASSWORD_FILES.map((rel) => ({
    rel,
    value: readPasswordFile(join(appbayHome, rel)),
  })).filter((f): f is { rel: string; value: string } => f.value !== null);

  if (present.length < 2) return;
  const [first, ...rest] = present;
  const conflicting = rest.filter((f) => f.value !== first.value);
  if (conflicting.length === 0) return;

  throw new Error(
    `Two different legacy passwords found — refusing to guess which one is the master.\n` +
      present.map((f) => `  ${f.rel}`).join("\n") +
      `\nThese were independent credentials: one opens var/lib/vault.enc, the other opens\n` +
      `var/lib/secrets.kdbx. RFC-001 §2 collapses them into a single master password, and\n` +
      `choosing for you would leave the other store readable by nothing.\n\n` +
      `Decide which store you are keeping, then write its password to\n` +
      `  ${MASTER_PASSWORD_REL}\n` +
      `and remove the legacy files.`,
  );
}

export interface ResolveMasterPasswordOptions {
  /** Generate and persist a password when none exists. Off by default — a read must not write. */
  generate?: boolean;
}

/**
 * Resolve the master password for this installation.
 *
 * @throws when no password can be found and `generate` was not requested, or when two
 *   different legacy passwords are present.
 */
export function resolveMasterPassword(
  appbayHome: string = defaultHome(),
  options: ResolveMasterPasswordOptions = {},
): string {
  const fromEnv = process.env.APPBAY_MASTER_PASSWORD;
  if (fromEnv) return fromEnv;

  const current = readPasswordFile(join(appbayHome, MASTER_PASSWORD_REL));
  if (current) return current;

  for (const name of LEGACY_ENV_VARS) {
    const value = process.env[name];
    if (value) return value;
  }

  assertLegacyFilesAgree(appbayHome);
  for (const rel of LEGACY_PASSWORD_FILES) {
    const value = readPasswordFile(join(appbayHome, rel));
    if (value) return value;
  }

  if (options.generate) return persistMasterPassword(appbayHome);

  throw new Error(
    `No master password found for ${appbayHome}.\n` +
      `Set APPBAY_MASTER_PASSWORD, or run 'appbay init' to create ${MASTER_PASSWORD_REL}.`,
  );
}

/**
 * Write a freshly generated master password and return it.
 *
 * 0600 is set at write time rather than after: a separate `chmod` leaves a window in which
 * the file exists at the umask's permissions, and this file is the root of the encryption
 * tree. The redundant `chmodSync` is kept for filesystems that ignore the mode on create.
 */
export function persistMasterPassword(
  appbayHome: string,
  password: string = randomBytes(24).toString("base64url"),
): string {
  const path = join(appbayHome, MASTER_PASSWORD_REL);
  mkdirSync(join(appbayHome, "var", "lib", "secrets"), { recursive: true });
  writeFileSync(path, password, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Some filesystems refuse chmod; the create-time mode above already applied.
  }
  return password;
}

/** Whether this installation has a master password at the §2 location. */
export function hasMasterPassword(appbayHome: string): boolean {
  return existsSync(join(appbayHome, MASTER_PASSWORD_REL));
}
