/**
 * The `${{project.KEY}}` variable store: the per-host values a manifest may reference.
 *
 * One reader, over the one instance-config loader, exposing an allow-list of keys. Two
 * readers with different rules once made `${{project.CONTAINER_RUNTIME}}` resolve on one
 * path and fail on the next (RFC-001 §4, decision 1.2b; docs/history has the account).
 * `${{namespace.KEY}}` is a separate, per-deployment store (docs/steering/product.md).
 */

import { loadInstanceConfig } from "../schemas/instance.js";

/**
 * Keys of the installation config that are exposed as `${{project.KEY}}` variables.
 *
 * An allow-list, not a deny-list: a key added to `etc/system.yaml` later must be opted IN
 * here. `home:` is the reason — it is machine state, not an operator variable, and a
 * deny-list would have leaked it the moment §2.1 wrote it.
 */
const EXPOSED_KEYS = ["domain"] as const;

/**
 * Read the `${{project.KEY}}` store from `$APPBAY_HOME`'s installation config.
 *
 * Reads `etc/system.yaml`, falling back to the legacy `project.yaml` (§2.1). Returns an
 * empty store rather than throwing when there is no config — an installation with no
 * `domain:` set is normal, and the resulting `${{project.DOMAIN}}` failure belongs to the
 * compile, where it names the app and the reference.
 */
export async function loadProjectVars(appbayHome: string): Promise<Record<string, string>> {
  const config = loadInstanceConfig(appbayHome).config;
  const vars: Record<string, string> = {};
  for (const key of EXPOSED_KEYS) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) vars[key.toUpperCase()] = value.trim();
  }
  return vars;
}

/**
 * Substitute `${{project.KEY}}` in a single value destined for a `.env.local` line.
 *
 * Distinct from the compiler's `ScopeResolver` on purpose: an UNKNOWN key degrades to
 * `${KEY}` rather than erroring, so it survives as a Compose-level variable the operator
 * can supply from the environment. That escape hatch is why this call site does not simply
 * use the resolver — the resolver's job is to fail the compile, this one's is to defer.
 */
export function resolveScopedVars(
  value: string,
  projectVars: Record<string, string>,
): string {
  return value.replace(/\$\{\{project\.(\w+)\}\}/g, (_match, key: string) => {
    return projectVars[key.toUpperCase()] ?? `\${${key}}`;
  });
}
