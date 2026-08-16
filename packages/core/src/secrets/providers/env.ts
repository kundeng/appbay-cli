/**
 * Environment variable secret provider.
 *
 * Resolves `env://VAR_NAME` URIs by reading the named environment variable
 * from `process.env`.
 */

import type { CheckResult, SecretProvider } from "../types.js";

/**
 * Extract the variable name from an `env://` URI.
 *
 * `env://DB_PASSWORD` -> `"DB_PASSWORD"`
 */
export function extractVarName(uri: string): string {
  // Strip the "env://" prefix (6 characters)
  return uri.slice("env://".length);
}

/** SecretProvider that reads values from environment variables. */
export class EnvSecretProvider implements SecretProvider {
  readonly scheme = "env";

  async resolve(uri: string): Promise<string> {
    const varName = extractVarName(uri);
    const value = process.env[varName];

    if (value === undefined) {
      throw new Error(
        `Environment variable "${varName}" is not set (URI: ${uri})`,
      );
    }

    return value;
  }

  async check(uri: string): Promise<CheckResult> {
    const varName = extractVarName(uri);
    const value = process.env[varName];

    if (value === undefined) {
      return {
        uri,
        ok: false,
        error: `Environment variable "${varName}" is not set`,
      };
    }

    return { uri, ok: true };
  }
}
