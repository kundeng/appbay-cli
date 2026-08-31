/**
 * Apply an installation's edge identity configuration to caddy's seeded files — RFC-001 §1,
 * task 5.1b. This is the wiring `renderEdgeSecurityBlock` and `edgeSecretEnvMapping` never had.
 *
 * ⭐ WHY A TRANSFORM AND NOT A TEMPLATE. `system-apps.ts` is a GENERATED file whose source of
 * truth is the `system-apps/` directory, so the shipped Caddyfile cannot itself be a function
 * of runtime config. This takes the seeded files and rewrites the parts the config touches,
 * which keeps `system-apps/` the authority on everything the config does NOT touch.
 *
 * 🚨 THE DEFAULT CONFIGURATION MUST BE A NO-OP, BYTE FOR BYTE. Every existing installation has
 * the single local store and no `edge_identity:` key, so if this changed anything for them it
 * would rewrite a working edge on the next `init --refresh`. `renderEdgeSecurityBlock` emits
 * the shipped block verbatim for the default config (asserted in `edge-portal-config.test.ts`),
 * and `applyEdgeIdentity` is asserted to return an unchanged record for it.
 *
 * 🚨 EVERY ANCHOR FAILURE THROWS. A transform that silently declines to find its anchor would
 * seed an edge with no LDAP provider while reporting success — the operator configures a
 * directory, restarts, and gets "wrong username or password" for every user with nothing
 * naming the cause. Loud is the only safe failure here.
 */

import type { EdgeIdentityConfig } from "../schemas/edge-identity-providers.js";
import { edgeSecretEnvMapping, renderEdgeSecurityBlock } from "./edge-portal-config.js";

const CADDYFILE = "config/Caddyfile";
const MANIFEST = "appbay.yaml";
const COMPOSE = "docker-compose.yml";

/** Thrown when a seeded caddy file no longer has the region this transform rewrites. */
export class EdgeAnchorError extends Error {
  constructor(file: string, anchor: string) {
    super(
      `Cannot apply edge identity config: ${file} has no ${anchor}. ` +
        `The shipped definition in system-apps/caddy/ changed shape — update ` +
        `services/edge-caddy-files.ts to match it rather than seeding an edge that ` +
        `silently ignores the configuration.`,
    );
    this.name = "EdgeAnchorError";
  }
}

/**
 * Replace the `security { … }` block inside the Caddyfile's global options block.
 *
 * The block is located by its opening line and its one-tab closing brace, the same bounds
 * `edge-portal-config.test.ts` uses to compare against the shipped text.
 */
function spliceSecurityBlock(caddyfile: string, config: EdgeIdentityConfig): string {
  const start = caddyfile.indexOf("\tsecurity {");
  if (start === -1) throw new EdgeAnchorError(CADDYFILE, "`security {` block");
  const closing = caddyfile.indexOf("\n\t}", start);
  if (closing === -1) throw new EdgeAnchorError(CADDYFILE, "closing brace for `security {`");
  const end = closing + "\n\t}".length;
  return caddyfile.slice(0, start) + renderEdgeSecurityBlock(config) + caddyfile.slice(end);
}

/**
 * Add each provider's secret reference to caddy's `secrets` trait.
 *
 * ⚠️ These are NOT added to `optional:`. The ACME credentials are optional because an install
 * with no DNS-01 legitimately has none; a bind password whose provider is configured is not
 * optional in the same way — a portal that starts with an unresolvable one authenticates
 * nobody and reports it as "wrong username or password" to every user. Failing at plan time
 * is the whole point of `collectEdgeSecretRefs`.
 */
function addSecretRefs(manifest: string, config: EdgeIdentityConfig): string {
  const mapping = edgeSecretEnvMapping(config);
  if (mapping.length === 0) return manifest;

  const anchor = "\n        optional:\n";
  const at = manifest.indexOf(anchor);
  if (at === -1) throw new EdgeAnchorError(MANIFEST, "`optional:` key in the secrets trait");

  const lines = mapping.map((m) => `          ${m.envVar}: "${m.ref}"`).join("\n");
  return `${manifest.slice(0, at)}\n${lines}${manifest.slice(at)}`;
}

/**
 * Declare each provider secret as a required compose environment variable.
 *
 * `:?required` rather than `:-`: an empty bind password is a working config file that
 * authenticates nobody, so the container must refuse to start instead.
 */
function addComposeEnv(compose: string, config: EdgeIdentityConfig): string {
  const mapping = edgeSecretEnvMapping(config);
  if (mapping.length === 0) return compose;

  const anchor = "      - AUTHP_ADMIN_SECRET=${AUTHP_ADMIN_SECRET:?required}\n";
  const at = compose.indexOf(anchor);
  if (at === -1) throw new EdgeAnchorError(COMPOSE, "the AUTHP_ADMIN_SECRET environment line");

  const insertAt = at + anchor.length;
  const lines = mapping.map((m) => `      - ${m.envVar}=\${${m.envVar}:?required}\n`).join("");
  return compose.slice(0, insertAt) + lines + compose.slice(insertAt);
}

/**
 * Rewrite caddy's seeded files for this installation's edge identity configuration.
 *
 * Returns a new record; the input is not mutated. For the default single-local-provider
 * configuration the result is byte-identical to the input, which is what makes calling this
 * unconditionally safe on every existing installation.
 */
export function applyEdgeIdentity(
  files: Record<string, string>,
  config: EdgeIdentityConfig,
): Record<string, string> {
  const caddyfile = files[CADDYFILE];
  if (caddyfile === undefined) throw new EdgeAnchorError(CADDYFILE, "any content — it is absent");
  const manifest = files[MANIFEST];
  if (manifest === undefined) throw new EdgeAnchorError(MANIFEST, "any content — it is absent");
  const compose = files[COMPOSE];
  if (compose === undefined) throw new EdgeAnchorError(COMPOSE, "any content — it is absent");

  return {
    ...files,
    [CADDYFILE]: spliceSecurityBlock(caddyfile, config),
    [MANIFEST]: addSecretRefs(manifest, config),
    [COMPOSE]: addComposeEnv(compose, config),
  };
}
