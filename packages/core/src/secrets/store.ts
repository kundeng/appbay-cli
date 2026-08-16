/**
 * SecretStore: central registry for secret providers and URI resolution.
 *
 * The store parses secret URIs, dispatches to the correct provider based on
 * scheme, and exposes bulk check operations. Providers are registered at
 * startup; unknown schemes produce clear error messages.
 */

import type { CheckResult, SecretProvider } from "./types.js";

// ---------------------------------------------------------------------------
// URI Parsing
// ---------------------------------------------------------------------------

/** Parsed components of a secret URI. */
export interface ParsedUri {
  /** URI scheme (e.g., "file", "env", "keepass", "sops"). */
  scheme: string;
  /** Scheme-specific path (everything after `scheme://`). */
  path: string;
}

/**
 * Supported URI schemes for secret references.
 *
 * A valid secret URI has the form `scheme://path` where scheme is one of
 * these values.
 */
const SUPPORTED_SCHEMES = new Set(["vault", "keepass", "file", "env", "sops"]);

// ---------------------------------------------------------------------------
// SecretStore
// ---------------------------------------------------------------------------

/**
 * Manages secret providers and resolves secret URIs.
 *
 * Usage:
 * ```ts
 * const store = new SecretStore();
 * store.registerProvider(new EnvSecretProvider());
 * store.registerProvider(new FileSecretProvider());
 *
 * const value = await store.resolve("env://DB_PASSWORD");
 * ```
 */
export class SecretStore {
  /** Provider registry keyed by scheme. */
  private providers = new Map<string, SecretProvider>();

  // -------------------------------------------------------------------------
  // Provider management
  // -------------------------------------------------------------------------

  /**
   * Register a secret provider for a URI scheme.
   *
   * If a provider for the same scheme is already registered, it is replaced.
   */
  registerProvider(provider: SecretProvider): void {
    this.providers.set(provider.scheme, provider);
  }

  // -------------------------------------------------------------------------
  // URI parsing
  // -------------------------------------------------------------------------

  /**
   * Parse a string into its URI components.
   *
   * @returns Parsed URI or `null` if the string is not a recognized secret URI.
   */
  parseUri(uri: string): ParsedUri | null {
    // Match `scheme://rest` where scheme is alphabetic
    const match = uri.match(/^([a-z]+):\/\/(.*)$/);
    if (!match) {
      return null;
    }

    const [, scheme, path] = match;
    if (!SUPPORTED_SCHEMES.has(scheme)) {
      return null;
    }

    return { scheme, path };
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve a secret URI to its plaintext value.
   *
   * @throws When the URI is invalid, the scheme is unknown, or the provider
   *         fails to resolve.
   */
  async resolve(uri: string): Promise<string> {
    const parsed = this.parseUri(uri);
    if (!parsed) {
      throw new Error(`Invalid or unsupported secret URI: ${uri}`);
    }

    const provider = this.providers.get(parsed.scheme);
    if (!provider) {
      throw new Error(
        `No provider registered for scheme "${parsed.scheme}" (URI: ${uri})`,
      );
    }

    return provider.resolve(uri);
  }

  // -------------------------------------------------------------------------
  // Health checks
  // -------------------------------------------------------------------------

  /**
   * Check whether a single secret URI can be resolved.
   */
  async check(uri: string): Promise<CheckResult> {
    const parsed = this.parseUri(uri);
    if (!parsed) {
      return { uri, ok: false, error: `Invalid or unsupported secret URI` };
    }

    const provider = this.providers.get(parsed.scheme);
    if (!provider) {
      return {
        uri,
        ok: false,
        error: `No provider registered for scheme "${parsed.scheme}"`,
      };
    }

    return provider.check(uri);
  }

  /**
   * Check multiple secret URIs in parallel.
   *
   * @returns One CheckResult per URI, in the same order as the input.
   */
  async checkAll(uris: string[]): Promise<CheckResult[]> {
    return Promise.all(uris.map((uri) => this.check(uri)));
  }
}
