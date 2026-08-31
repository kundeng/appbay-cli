/**
 * The `${{project.KEY}}` variable store — RFC-001 §4, decision 1.2b.
 *
 * ONE reader for the installation config's variables, because there were two and they
 * disagreed:
 *
 *   - `deploy-service.ts` regex-matched `^domain:` and produced `{ DOMAIN }` — the compile
 *     path, and the behaviour `docs/reference/scope-model.qmd` documents.
 *   - `catalog-service.ts` YAML-parsed the same file and uppercased EVERY top-level string
 *     key — the catalog-install path, undocumented and untested.
 *
 * So `${{project.CONTAINER_RUNTIME}}` resolved when a catalog app was installed and failed
 * to compile a moment later. §2.1 made it worse by adding `home:` to that file: on the
 * catalog path `${{project.HOME}}` had started interpolating an absolute filesystem path
 * into a manifest's `.env.local`.
 *
 * This module keeps the DOCUMENTED, narrow behaviour. Measured across both catalogs, the
 * UOM fixtures and `system-apps/`, the only reference that resolves anywhere is
 * `${{project.DOMAIN}}` — every other key is zero uses — so narrowing the wide path costs
 * nothing real and closes the path leak.
 *
 * 🚦 NOT renamed to `${{namespace.KEY}}`, deliberately. `namespace:` is a per-app LABEL that
 * disambiguates container names, network aliases and state keys; it has no variable store
 * and never had one. `${{project.KEY}}` reads the per-HOST installation config. They shared
 * a word, not a concept — the rename would aim 234 references at a scope holding nothing.
 */

import { readFileSync } from "node:fs";
import { readInstanceConfigText } from "../schemas/instance.js";

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
  try {
    const text = readInstanceConfigText(appbayHome, (p) => readFileSync(p, "utf-8")) ?? "";
    const vars: Record<string, string> = {};
    for (const key of EXPOSED_KEYS) {
      const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
      const value = match?.[1]?.trim();
      if (value) vars[key.toUpperCase()] = value;
    }
    return vars;
  } catch {
    return {};
  }
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
