/**
 * File-based secret provider.
 *
 * Resolves `file:///path/to/secret` URIs by reading the file content from the
 * local filesystem. The value is trimmed of trailing whitespace.
 *
 * Auto-generate (Feature 1.13): when a secret file does not exist and
 * `autoGenerate` is enabled (the default), a 32-character cryptographically
 * random password is generated, written to the file (parent directories are
 * created as needed), and returned. This mirrors how magic vars work —
 * generate once, persist forever.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CheckResult, SecretProvider } from "../types.js";
import { generatePassword } from "../../state/generated-values.js";

/** Length of auto-generated secret values (characters). */
const AUTO_GENERATE_LENGTH = 32;

/**
 * Extract the file path from a `file://` URI.
 *
 * `file:///run/secrets/db_password` -> `"/run/secrets/db_password"`
 *
 * Note: `file://` URIs use three slashes for absolute paths because the
 * authority component is empty (RFC 8089).
 */
export function extractFilePath(uri: string): string {
  // Strip the "file://" prefix (7 characters), preserving the leading "/"
  return uri.slice("file://".length);
}

/** Options for the FileSecretProvider. */
export interface FileSecretProviderOptions {
  /**
   * When `true` (the default), a missing secret file is auto-generated with a
   * cryptographically random password and written to disk before returning.
   * Set to `false` to disable auto-generation and throw on missing files.
   */
  autoGenerate?: boolean;
}

/** SecretProvider that reads values from the local filesystem. */
export class FileSecretProvider implements SecretProvider {
  readonly scheme = "file";

  private readonly autoGenerate: boolean;

  constructor(options: FileSecretProviderOptions = {}) {
    this.autoGenerate = options.autoGenerate ?? true;
  }

  async resolve(uri: string): Promise<string> {
    const filePath = extractFilePath(uri);

    try {
      const content = await fs.readFile(filePath, "utf-8");
      return content.trimEnd();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;

      if (code === "ENOENT" && this.autoGenerate) {
        return this._autoGenerate(filePath, uri);
      }

      if (code === "ENOENT") {
        throw new Error(`Secret file not found: ${filePath} (URI: ${uri})`);
      }
      throw new Error(
        `Failed to read secret file: ${filePath} (URI: ${uri}): ${(err as Error).message}`,
      );
    }
  }

  async check(uri: string): Promise<CheckResult> {
    const filePath = extractFilePath(uri);

    try {
      await fs.access(filePath, fs.constants.R_OK);
      return { uri, ok: true };
    } catch {
      if (this.autoGenerate) {
        // File is missing but will be created on first deploy — not an error.
        return { uri, ok: true };
      }
      return {
        uri,
        ok: false,
        error: `Secret file not found or not readable: ${filePath}`,
      };
    }
  }

  /**
   * Generate a random secret value, persist it to `filePath`, and return it.
   * Parent directories are created as needed (recursive mkdir).
   */
  private async _autoGenerate(filePath: string, uri: string): Promise<string> {
    const value = generatePassword(AUTO_GENERATE_LENGTH);
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      // Write with mode 0o600 so only the owner can read the secret.
      await fs.writeFile(filePath, value, { encoding: "utf-8", mode: 0o600 });
    } catch (writeErr) {
      throw new Error(
        `Secret file not found and auto-generation failed for: ${filePath} (URI: ${uri}): ${(writeErr as Error).message}`,
      );
    }
    return value;
  }
}
