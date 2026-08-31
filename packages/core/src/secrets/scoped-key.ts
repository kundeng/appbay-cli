/**
 * The scope/key split — RFC-001 §3.3.
 *
 * A scoped secret key is `SCOPE/.../KEY`: the LAST segment is the key, everything before it
 * is the scope, and a bare `KEY` is scoped `default`.
 *
 * 🚨 THIS WAS WRITTEN NINE TIMES. Six copies in `vault-service.ts`, two in the CLI's
 * `secrets.ts`, and the equivalent inside `parseVaultUri`. All byte-identical, which is what
 * a fork looks like before it diverges: the same three lines maintained in nine places, so a
 * change to how scoping works has nine chances to be applied eight times.
 */

/** A secret key split into its scope and its final segment. */
export interface ScopedKey {
  /** Everything before the final segment; `"default"` for a bare key. */
  scope: string;
  /** The final segment. */
  key: string;
}

/**
 * Split `SCOPE/.../KEY` into its scope and key.
 *
 * ⚠️ Arbitrary depth, deliberately. `vault://a/b/c/d/FIELD` resolves `FIELD` under `a/b/c/d`;
 * the three-segment shape some docs described was never a limit the parser imposed.
 */
export function splitScopedKey(keyArg: string): ScopedKey {
  const parts = keyArg.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error(`Empty secret key: ${JSON.stringify(keyArg)}`);
  }
  const key = parts[parts.length - 1]!;
  const scope = parts.length > 1 ? parts.slice(0, -1).join("/") : "default";
  return { scope, key };
}
