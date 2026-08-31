/**
 * SOPS secret provider.
 *
 * Resolves `sops://<path>#<key>` URIs by decrypting a SOPS-encrypted file
 * and extracting the named key using the `sops` CLI.
 *
 * URI format:
 *   sops://<absolute-or-relative-file-path>#<dot.notation.key>
 *
 * Examples:
 *   sops:///etc/appbay/secrets.yaml#database.password
 *   sops://./secrets/prod.yaml#DB_PASSWORD
 *
 * The fragment (`#key`) supports dot notation for nested values:
 *   `sops:///secrets.yaml#services.postgres.password`
 *   → jq-style path `["services"]["postgres"]["password"]`
 *
 * Requirements:
 *   - `sops` CLI binary on PATH (https://github.com/getsops/sops)
 *   - Decryption key accessible (GPG keyring, AWS KMS, age key, etc.)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import type { CheckResult, SecretProvider } from "../types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// URI parsing
// ---------------------------------------------------------------------------

interface ParsedSopsUri {
  filePath: string;
  /** Dot-notation key, e.g. "database.password" or "DB_PASSWORD". */
  key: string;
}

/**
 * Parse a `sops://` URI into file path and key.
 *
 * `sops:///etc/appbay/secrets.yaml#database.password`
 *   → { filePath: "/etc/appbay/secrets.yaml", key: "database.password" }
 */
export function parseSopsUri(uri: string): ParsedSopsUri {
  // Strip scheme
  const withoutScheme = uri.slice("sops://".length);

  const hashIdx = withoutScheme.indexOf("#");
  if (hashIdx === -1) {
    throw new Error(
      `Invalid sops:// URI — missing '#key' fragment. Expected sops://<file>#<key>, got: ${uri}`,
    );
  }

  const filePath = withoutScheme.slice(0, hashIdx);
  const key = withoutScheme.slice(hashIdx + 1);

  if (!filePath) {
    throw new Error(`Invalid sops:// URI — empty file path: ${uri}`);
  }
  if (!key) {
    throw new Error(`Invalid sops:// URI — empty key fragment: ${uri}`);
  }

  return { filePath, key };
}

/**
 * Characters that would change the SHAPE of the extract path rather than name a key.
 *
 * 🚨 THE PATH IS BUILT BY CONCATENATION, so a key containing any of these rewrites the
 * structure instead of being quoted into it. Measured:
 *
 *     toExtractPath('a"]["b')  ->  ["a"]["b"]
 *     toExtractPath('a.b')     ->  ["a"]["b"]      ← identical
 *
 * Two different URIs therefore select the SAME secret, silently. And a lone quote produces
 * `["x"]"]`, which is not valid jq at all — sops then fails with a syntax complaint that
 * names neither the key nor the character responsible.
 *
 * ⚠️ This is not shell injection: `execFile` takes an argv array, so nothing reaches a shell.
 * It is path injection into sops's own extract expression, and the fix is the same shape —
 * refuse the input rather than try to escape it, because the correct escaping is sops's to
 * define and guessing it is how the next version of this bug gets written.
 */
const PATH_BREAKING = /["[\]]/;

/**
 * Convert a dot-notation key to a `--extract` jq-style path.
 *
 * "database.password" → `["database"]["password"]`
 * "DB_PASSWORD"        → `["DB_PASSWORD"]`
 *
 * Throws when a segment carries a character that would alter the path structure — see
 * PATH_BREAKING. An empty segment (`a..b`, `.a`) is refused for the same reason: it would
 * emit `[""]`, which addresses a key nobody can have written deliberately.
 */
export function toExtractPath(key: string): string {
  const parts = key.split(".");
  for (const part of parts) {
    if (part === "") {
      throw new Error(
        `Invalid sops key "${key}" — empty path segment. Use dots to separate keys, ` +
          `not to pad them.`,
      );
    }
    const bad = PATH_BREAKING.exec(part);
    if (bad) {
      throw new Error(
        `Invalid sops key "${key}" — the character ${JSON.stringify(bad[0])} would change ` +
          `the extract path rather than name a key. Quotes and brackets are not permitted ` +
          `in a sops key.`,
      );
    }
  }
  return parts.map((part) => `["${part}"]`).join("");
}

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

async function isCLIAvailable(): Promise<boolean> {
  try {
    await execFileAsync("sops", ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function cliDecryptKey(parsed: ParsedSopsUri): Promise<string> {
  const extractPath = toExtractPath(parsed.key);

  const { stdout } = await execFileAsync(
    "sops",
    ["--decrypt", `--extract=${extractPath}`, parsed.filePath],
    { timeout: 30_000, env: process.env },
  );

  const value = stdout.trim();
  if (!value) {
    throw new Error(
      `SOPS returned empty value for key "${parsed.key}" in ${parsed.filePath}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** SecretProvider that resolves `sops://` URIs via the SOPS CLI. */
export class SopsSecretProvider implements SecretProvider {
  readonly scheme = "sops";

  async resolve(uri: string): Promise<string> {
    let parsed: ParsedSopsUri;
    try {
      parsed = parseSopsUri(uri);
    } catch (err) {
      throw new Error((err as Error).message);
    }

    if (!(await isCLIAvailable())) {
      throw new Error(
        `SOPS CLI not found. Install it from https://github.com/getsops/sops. URI: ${uri}`,
      );
    }

    try {
      return await cliDecryptKey(parsed);
    } catch (err) {
      const msg = (err as Error).message;
      throw new Error(
        `Failed to resolve SOPS secret "${parsed.key}" from ${parsed.filePath}: ${msg}`,
      );
    }
  }

  async check(uri: string): Promise<CheckResult> {
    let parsed: ParsedSopsUri;
    try {
      parsed = parseSopsUri(uri);
    } catch (err) {
      return { uri, ok: false, error: (err as Error).message };
    }

    if (!(await isCLIAvailable())) {
      return {
        uri,
        ok: false,
        error: "SOPS CLI not found. Install from https://github.com/getsops/sops",
      };
    }

    // Check file existence before attempting decryption (faster fail).
    try {
      await access(parsed.filePath);
    } catch {
      return {
        uri,
        ok: false,
        error: `SOPS file not found or not readable: ${parsed.filePath}`,
      };
    }

    try {
      await cliDecryptKey(parsed);
      return { uri, ok: true };
    } catch (err) {
      return { uri, ok: false, error: (err as Error).message };
    }
  }
}
