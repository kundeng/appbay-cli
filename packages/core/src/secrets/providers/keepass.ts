/**
 * KeePass secret provider.
 *
 * Resolves `keepass://PATH/TO/ENTRY` URIs from a KeePass `.kdbx` database
 * via the `keepassxc-cli` command-line tool.
 *
 * URI format:
 *   keepass://GROUP/ENTRY           — lookup entry in group, return Password field
 *   keepass://GROUP/ENTRY/FIELD     — lookup specific field (Username, URL, etc.)
 *
 * The KeePass database file is configured via:
 *   APPBAY_KEEPASS_DB       — path to .kdbx file (default: $APPBAY_HOME/var/lib/secrets.kdbx)
 *   APPBAY_KEEPASS_PASSWORD — database master password (or APPBAY_VAULT_PASSWORD as fallback)
 *   APPBAY_KEEPASS_KEYFILE  — optional key file path
 *
 * Why KeePass:
 *   - Lightweight, well-understood format (.kdbx)
 *   - Users can browse/edit secrets with KeePassXC desktop app
 *   - KeeWeb container provides a web UI for the same .kdbx file
 *   - Many homelab users already use KeePass
 *   - keepassxc-cli is widely packaged (apt install keepassxc)
 */

import { runKeepassxc, stdinLines } from "../keepassxc-cli.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, SecretProvider } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEME = "keepass";
const DEFAULT_DB_NAME = "secrets.kdbx";

// ---------------------------------------------------------------------------
// URI parsing
// ---------------------------------------------------------------------------

interface ParsedKeePassUri {
  /** Entry path within the database (e.g., "appbay/kestra/DB_PASSWORD"). */
  entryPath: string;
  /** Field to retrieve (default: "Password"). */
  field: string;
}

/**
 * Parse a keepass:// URI.
 *
 * keepass://appbay/kestra/DB_PASSWORD      → entryPath: "appbay/kestra/DB_PASSWORD", field: "Password"
 * keepass://appbay/kestra/DB_PASSWORD/URL  → entryPath: "appbay/kestra/DB_PASSWORD", field: "URL"
 */
function parseKeePassUri(uri: string): ParsedKeePassUri {
  const withoutScheme = uri.slice("keepass://".length);
  const parts = withoutScheme.split("/").filter((s) => s.length > 0);

  if (parts.length === 0) {
    throw new Error(`Invalid keepass:// URI — expected keepass://GROUP/ENTRY: ${uri}`);
  }

  // Check if last segment is a known KeePass field name
  const knownFields = ["Password", "Username", "URL", "Notes", "Title"];
  const lastPart = parts[parts.length - 1];
  if (parts.length > 1 && knownFields.includes(lastPart)) {
    return {
      entryPath: parts.slice(0, -1).join("/"),
      field: lastPart,
    };
  }

  return { entryPath: parts.join("/"), field: "Password" };
}

// ---------------------------------------------------------------------------
// KeePass database resolution
// ---------------------------------------------------------------------------

function resolveDbPath(): string {
  if (process.env.APPBAY_KEEPASS_DB) {
    return process.env.APPBAY_KEEPASS_DB;
  }

  const appbayHome =
    process.env.APPBAY_HOME ??
    join(process.env.HOME ?? "/root", ".appbay");
  return join(appbayHome, "var", "lib", DEFAULT_DB_NAME);
}

function resolveDbPassword(): string {
  // 1. Dedicated KeePass env var
  if (process.env.APPBAY_KEEPASS_PASSWORD) {
    return process.env.APPBAY_KEEPASS_PASSWORD;
  }

  // 2. Dedicated KeePass password file ($APPBAY_HOME/etc/kdbx-password)
  const appbayHome =
    process.env.APPBAY_HOME ??
    join(process.env.HOME ?? "/root", ".appbay");
  const kdbxPasswordPath = join(appbayHome, "etc", "kdbx-password");
  try {
    const filePassword = readFileSync(kdbxPasswordPath, "utf-8").trim();
    if (filePassword) return filePassword;
  } catch {
    // File doesn't exist — fall through
  }

  // 3. Shared vault password env var (fallback)
  if (process.env.APPBAY_VAULT_PASSWORD) {
    return process.env.APPBAY_VAULT_PASSWORD;
  }

  // 4. Shared vault password file (fallback)
  const vaultPasswordPath = join(appbayHome, "etc", "vault-password");
  try {
    const filePassword = readFileSync(vaultPasswordPath, "utf-8").trim();
    if (filePassword) return filePassword;
  } catch {
    // File doesn't exist
  }

  return "";
}

// ---------------------------------------------------------------------------
// keepassxc-cli invocation
// ---------------------------------------------------------------------------

async function isCliAvailable(): Promise<boolean> {
  try {
    await runKeepassxc(["--version"], "", 5_000);
    return true;
  } catch {
    return false;
  }
}

async function cliShow(
  dbPath: string,
  password: string,
  entryPath: string,
  field: string,
  keyFile?: string,
): Promise<string> {
  // The master password goes down stdin, never into an argv. See keepassxc-cli.ts for why
  // the `echo '<password>' | …` this replaces was a disclosure bug and not an escaping one.
  const args = ["show", "--quiet", "--attributes", field];
  if (keyFile) args.push("--key-file", keyFile);
  args.push(dbPath, entryPath);

  const { stdout } = await runKeepassxc(args, stdinLines(password));

  const value = stdout.trim();
  if (!value) {
    throw new Error(`KeePass entry "${entryPath}" has empty ${field} field`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * SecretProvider for `keepass://` URIs backed by a KeePass .kdbx database.
 *
 * Uses keepassxc-cli to read entries. Users can browse/edit the same
 * .kdbx file with KeePassXC desktop app or a KeeWeb container.
 */
export class KeePassSecretProvider implements SecretProvider {
  readonly scheme = SCHEME;

  async resolve(uri: string): Promise<string> {
    const parsed = parseKeePassUri(uri);
    const dbPath = resolveDbPath();
    const password = resolveDbPassword();

    if (!existsSync(dbPath)) {
      throw new Error(
        `KeePass database not found at ${dbPath}. Run 'appbay secrets init-kdbx' or set APPBAY_KEEPASS_DB.`,
      );
    }

    if (!(await isCliAvailable())) {
      throw new Error(
        "keepassxc-cli not found. Install it: apt install keepassxc (or brew install keepassxc on macOS).",
      );
    }

    return cliShow(
      dbPath,
      password,
      parsed.entryPath,
      parsed.field,
      process.env.APPBAY_KEEPASS_KEYFILE,
    );
  }

  async check(uri: string): Promise<CheckResult> {
    try {
      const parsed = parseKeePassUri(uri);
      const dbPath = resolveDbPath();

      if (!existsSync(dbPath)) {
        return { uri, ok: false, error: `KeePass database not found at ${dbPath}` };
      }

      if (!(await isCliAvailable())) {
        return { uri, ok: false, error: "keepassxc-cli not found" };
      }

      const password = resolveDbPassword();
      await cliShow(
        dbPath,
        password,
        parsed.entryPath,
        "Password",
        process.env.APPBAY_KEEPASS_KEYFILE,
      );
      return { uri, ok: true };
    } catch (err) {
      return { uri, ok: false, error: (err as Error).message };
    }
  }
}

export { parseKeePassUri };
