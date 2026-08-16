/**
 * Type definitions for the Appbay secret resolution system.
 *
 * Secrets are referenced via URI strings (e.g., `vault://app/DB_PASSWORD`,
 * `keepass://db/group/entry`, `file:///run/secrets/db_password`). Each URI scheme maps
 * to a pluggable SecretProvider that knows how to resolve the value.
 *
 * See design.md "Secrets Model" and agents.md "Secrets" for details.
 */

// ---------------------------------------------------------------------------
// Check Result
// ---------------------------------------------------------------------------

/** Result of checking whether a secret URI can be resolved. */
export interface CheckResult {
  /** The original secret URI that was checked. */
  uri: string;
  /** Whether the URI can be resolved successfully. */
  ok: boolean;
  /** Human-readable error message when `ok` is false. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Secret Provider
// ---------------------------------------------------------------------------

/**
 * A SecretProvider resolves secret values for a specific URI scheme.
 *
 * Providers are registered with the SecretStore and dispatched based on the
 * URI scheme (e.g., "file", "env", "keepass", "sops").
 */
export interface SecretProvider {
  /** The URI scheme this provider handles (e.g., "keepass", "file", "env", "sops"). */
  scheme: string;

  /**
   * Resolve a secret URI to its plaintext value.
   *
   * @param uri - The full URI string (e.g., `file:///run/secrets/db_password`).
   * @returns The resolved secret value.
   * @throws When the secret cannot be resolved.
   */
  resolve(uri: string): Promise<string>;

  /**
   * Check whether a secret URI can be resolved without actually reading the value.
   *
   * @param uri - The full URI string to check.
   * @returns A CheckResult indicating success or failure with an error message.
   */
  check(uri: string): Promise<CheckResult>;
}
