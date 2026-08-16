/**
 * Typed configuration for where edge users come from.
 *
 * ⚠️ EDGE IDENTITIES ARE NOT APPBAY CONTROL-PLANE ACCOUNTS. Three credential domains
 * exist and are never silently synchronized:
 *
 *   control-plane user  ->  enters AppBay itself        (etc/control-plane/users.yaml)
 *   vault password      ->  decrypts vault.enc          (independent)
 *   edge user           ->  enters DEPLOYED APPS        (this file)
 *
 * Merging any two of them is the failure this separation exists to prevent: an operator
 * who can open an app must not thereby be able to reconfigure the installation.
 *
 * 🚨 SECRETS HERE ARE URI REFERENCES, NEVER VALUES. A bind password or client secret is
 * written as `vault://edge/ldap-bind`, and resolves only at deploy time on the host that
 * needs it. A literal is rejected by the schema rather than quietly accepted, because a
 * plaintext credential in `project.yaml` is a credential in git, in the plan diff, and in
 * every render — and nothing downstream would flag it.
 */

import { z } from "zod";

/** A `scheme://path` secret reference. The resolver owns which schemes exist. */
const SecretRefSchema = z
  .string()
  .min(1)
  .refine((v) => /^[a-z][a-z0-9+.-]*:\/\//i.test(v), {
    message:
      "must be a secret reference URI (e.g. vault://edge/bind-password), not a literal value",
  });

/**
 * Caddy Security's own JSON store, managed by `appbay edge users`.
 *
 * The default, and the only provider that needs no external system. Caddy Security owns
 * the file's contents at runtime — AppBay creates and seeds it, then leaves it alone.
 */
export const LocalEdgeProviderSchema = z.object({
  type: z.literal("local"),
  /** Realm shown on the portal and stamped into issued identities. */
  realm: z.string().min(1).default("local"),
});

/** LDAP / Active Directory. */
export const LdapEdgeProviderSchema = z.object({
  type: z.literal("ldap"),
  realm: z.string().min(1),
  /** e.g. `ldaps://dc1.example.edu:636`. */
  servers: z.array(z.string().url()).min(1),
  /** ⚠️ Disabling TLS verification is a deliberate, visible choice — not a default. */
  tlsInsecureSkipVerify: z.boolean().default(false),
  bindDn: z.string().min(1),
  bindPasswordRef: SecretRefSchema,
  searchBaseDn: z.string().min(1),
  /** `%s` is substituted with the submitted username. */
  searchUserFilter: z.string().min(1).default("(&(objectclass=person)(uid=%s))"),
  searchGroupFilter: z.string().min(1).optional(),
  /**
   * Maps a directory group DN to an AppBay edge role.
   *
   * ⚠️ An empty map means NO ONE is granted a role. That is the safe direction — a
   * misconfigured map should admit nobody rather than everybody — but it will look like
   * "login works, nothing is reachable", so `appbay doctor` should say so plainly.
   */
  groupRoleMap: z.record(z.string(), z.array(z.string().min(1))).default({}),
});

/** OIDC / OAuth2 (Okta, Entra, Google, Keycloak, …). */
export const OidcEdgeProviderSchema = z.object({
  type: z.literal("oidc"),
  realm: z.string().min(1),
  /** Discovery document base URL; the provider appends `/.well-known/openid-configuration`. */
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecretRef: SecretRefSchema,
  scopes: z.array(z.string().min(1)).min(1).default(["openid", "email", "profile"]),
  /** Claim carrying group membership. Providers disagree; make it explicit. */
  groupsClaim: z.string().min(1).default("groups"),
  groupRoleMap: z.record(z.string(), z.array(z.string().min(1))).default({}),
});

export const EdgeIdentityProviderSchema = z.discriminatedUnion("type", [
  LocalEdgeProviderSchema,
  LdapEdgeProviderSchema,
  OidcEdgeProviderSchema,
]);
export type EdgeIdentityProvider = z.infer<typeof EdgeIdentityProviderSchema>;

/**
 * The installation's edge identity configuration.
 *
 * ⚠️ Provider order is load-bearing: Caddy Security tries them in sequence, so a broad
 * provider listed first shadows a narrower one after it.
 */
export const EdgeIdentityConfigSchema = z.object({
  providers: z.array(EdgeIdentityProviderSchema).min(1).default([{ type: "local", realm: "local" }]),
  /** Path the auth portal is served at, relative to the edge host. */
  portalPath: z.string().startsWith("/").default("/auth"),
});
export type EdgeIdentityConfig = z.infer<typeof EdgeIdentityConfigSchema>;

/**
 * Collect every secret reference an edge configuration depends on.
 *
 * Used at plan time to fail on an unresolvable reference BEFORE the edge is reconfigured —
 * a portal that starts with a broken bind password authenticates nobody, and the failure
 * appears as "wrong username or password" to every user rather than as a config error.
 */
export function collectEdgeSecretRefs(config: EdgeIdentityConfig): string[] {
  const refs: string[] = [];
  for (const p of config.providers) {
    if (p.type === "ldap") refs.push(p.bindPasswordRef);
    if (p.type === "oidc") refs.push(p.clientSecretRef);
  }
  return refs;
}
