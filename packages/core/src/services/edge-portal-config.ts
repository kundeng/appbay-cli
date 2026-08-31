/**
 * Render Caddy Security portal + authentication blocks from typed edge identity config.
 *
 * ⭐ WHY A SEPARATE FILE FROM THE AUTH TRAIT. The trait emits a PER-APP fragment saying
 * "this app requires these roles". This emits the INSTALLATION-WIDE block saying "here is
 * who exists and how they prove it". One is per-app policy; the other is the identity
 * plane. Conflating them is how an app manifest ends up naming an LDAP server.
 *
 * 🚨 SECRET REFERENCES ARE NOT RESOLVED HERE. This renders `{env.LDAP_BIND_PASSWORD}` and
 * the deploy path supplies that variable from the resolved reference. Rendering the value
 * would put a bind password in `var/lib/renders/**`, which is on disk, in the plan diff,
 * and reproducible from inputs — exactly the places a credential must not be.
 *
 * 🚨 THIS MUST REPRODUCE THE SHIPPED BLOCK BYTE FOR BYTE FOR THE DEFAULT CONFIG.
 * The live `security { }` lives inside the global options block of
 * `system-apps/caddy/config/Caddyfile`; this renderer was an earlier, INCOMPLETE draft of it
 * and wiring it as written would have broken a working edge four ways:
 *
 *   1. `path /config/security/users.json` — wrong VOLUME. `./config/security` is mounted at
 *      `/etc/caddy/security`; `/config` is the separate anonymous `caddy-config` volume, so
 *      the local store would have pointed at a file nothing writes.
 *   2. portal named `appbay` — `auth.ts:57` emits `authenticate * with appbay_portal`, so
 *      every per-app auth fragment would name a portal that does not exist.
 *   3. no `crypto key sign-verify {$APPBAY_EDGE_TOKEN_SECRET}` — `auth.ts:42` emits the
 *      matching `crypto key verify`, so the portal would sign with an ephemeral key and
 *      per-app verification would fail against it.
 *   4. no `import /etc/caddy/security/policies/*.caddy` — that import is how the
 *      `authorize with <policy>` from `auth.ts:59` finds its policy at all.
 *
 * Each is silent: the edge starts, the config parses, and nobody can get in. So the renderer
 * now emits the shipped text for the default single-local-provider config and only ADDS to it
 * when ldap/oidc providers are configured — the same "omit when default" discipline that kept
 * the §4 namespace out of existing container names. `edge-portal-config.test.ts` asserts the
 * byte-for-byte equality against the shipped file, which is what makes wiring it a no-op.
 */

import type { EdgeIdentityConfig, EdgeIdentityProvider } from "../schemas/edge-identity-providers.js";

/** Env var name carrying a provider's resolved secret at container start. */
export function edgeSecretEnvVar(provider: EdgeIdentityProvider): string | null {
  if (provider.type === "ldap") return `EDGE_LDAP_BIND_PASSWORD_${provider.realm.toUpperCase()}`;
  if (provider.type === "oidc") return `EDGE_OIDC_CLIENT_SECRET_${provider.realm.toUpperCase()}`;
  return null;
}

/**
 * Caddy Security store name for a realm.
 *
 * The shipped block calls the local store `appbay_local` while its realm is `local` — the
 * two are different identifiers and `enable identity store` takes the NAME. Deriving the
 * name from the realm keeps them in lockstep and reproduces the shipped name exactly.
 */
function storeName(realm: string): string {
  return `appbay_${realm}`;
}

/** Container path of the local user store. See the mount note in the header — NOT `/config`. */
const LOCAL_USERS_PATH = "/etc/caddy/security/users.json";

function renderLocal(p: Extract<EdgeIdentityProvider, { type: "local" }>): string[] {
  return [
    `\t\tlocal identity store ${storeName(p.realm)} {`,
    `\t\t\trealm ${p.realm}`,
    `\t\t\tpath ${LOCAL_USERS_PATH}`,
    `\t\t}`,
  ];
}

/**
 * ⚠️ LDAP is an identity **store**; OAuth/OIDC is an identity **provider**. Caddy Security
 * draws that distinction and rejects the wrong noun with "wrong argument count or
 * unexpected line ending" — a message that points at the realm name, not at the noun.
 * Verified against the pinned binary with `caddy validate`; do not "tidy" these to match.
 */
function renderLdap(p: Extract<EdgeIdentityProvider, { type: "ldap" }>): string[] {
  const out = [
    `\t\tldap identity store ${storeName(p.realm)} {`,
    `\t\t\trealm ${p.realm}`,
    // 🚨 `servers` IS A BLOCK, NOT A REPEATED DIRECTIVE. Written as `servers <url>` per line
    // the Caddyfile still ADAPTS — no parse error — and then provisioning fails with
    // "no authentication servers found", because the addresses land nowhere. Caught only by
    // running `caddy validate` against the pinned image; every unit test passed on the
    // broken form. Do not flatten this back to one line per server.
    `\t\t\tservers {`,
    ...p.servers.map((s) => `\t\t\t\t${s}${p.tlsInsecureSkipVerify ? " ignore_cert_errors" : ""}`),
    `\t\t\t}`,
    `\t\t\tattributes {`,
    `\t\t\t\tname givenName`,
    `\t\t\t\tsurname sn`,
    `\t\t\t\tusername sAMAccountName`,
    `\t\t\t\tmember_of memberOf`,
    `\t\t\t\temail mail`,
    `\t\t\t}`,
    `\t\t\tusername "${p.bindDn}"`,
    `\t\t\tpassword "{env.${edgeSecretEnvVar(p) ?? ""}}"`,
    `\t\t\tsearch_base_dn ${p.searchBaseDn}`,
    `\t\t\tsearch_user_filter "${p.searchUserFilter}"`,
  ];
  if (p.searchGroupFilter) out.push(`\t\t\tsearch_group_filter "${p.searchGroupFilter}"`);
  for (const [dn, roles] of Object.entries(p.groupRoleMap)) {
    out.push(`\t\t\tgroups {`, `\t\t\t\t"${dn}" ${roles.join(" ")}`, `\t\t\t}`);
  }
  out.push(`\t\t}`);
  return out;
}

function renderOidc(p: Extract<EdgeIdentityProvider, { type: "oidc" }>): string[] {
  return [
    // 🚨 THE DRIVER IS A DIRECTIVE, NOT A POSITIONAL TOKEN. `oauth identity provider generic
    // <name>` is rejected at adapt time with `unsupported "generic" shortcut: [<name>]` — the
    // token after `provider` is the NAME, and the driver goes inside the block. Verified
    // against the pinned image; all three wrong forms were tried and only this one adapts.
    `\t\toauth identity provider ${storeName(p.realm)} {`,
    `\t\t\trealm ${p.realm}`,
    `\t\t\tdriver generic`,
    `\t\t\tbase_auth_url ${p.issuerUrl}`,
    `\t\t\tmetadata_url ${p.issuerUrl.replace(/\/+$/, "")}/.well-known/openid-configuration`,
    `\t\t\tclient_id ${p.clientId}`,
    `\t\t\tclient_secret "{env.${edgeSecretEnvVar(p) ?? ""}}"`,
    `\t\t\tscopes ${p.scopes.join(" ")}`,
    `\t\t\tuser_group_filters ${p.groupsClaim}`,
    `\t\t}`,
  ];
}

/**
 * Render the whole `security { ... }` block, indented for the global options block.
 *
 * ⚠️ Provider order is preserved verbatim. Caddy Security evaluates providers in the order
 * declared, so reordering here would silently change which realm authenticates a user.
 *
 * The output is the SHIPPED block verbatim when `config` is the default single local
 * provider. Everything below that is not a provider declaration — the signing key, the ui
 * block, the transform, the policy import — is unconditional, because each is load-bearing
 * for every configuration, not just the default one.
 */
export function renderEdgeSecurityBlock(config: EdgeIdentityConfig): string {
  const lines: string[] = ["\tsecurity {"];

  for (const [i, p] of config.providers.entries()) {
    if (i > 0) lines.push("");
    if (p.type === "local") lines.push(...renderLocal(p));
    else if (p.type === "ldap") lines.push(...renderLdap(p));
    else lines.push(...renderOidc(p));
  }

  const primary = config.providers[0];
  lines.push(
    "",
    `\t\tauthentication portal appbay_portal {`,
    `\t\t\tcrypto default token lifetime 3600`,
    // 🚨 The portal SIGNS with this key and `auth.ts:42` emits `crypto key verify` with the
    // same one. Drop it here and the portal signs with a per-start ephemeral key, so every
    // per-app authorize check rejects a token the portal just issued.
    `\t\t\tcrypto key sign-verify {$APPBAY_EDGE_TOKEN_SECRET}`,
    `\t\t\tenable identity store ${storeName(primary?.realm ?? "local")}`,
    `\t\t\tui {`,
    `\t\t\t\ttheme basic`,
    `\t\t\t}`,
    "",
    `\t\t\t# 🚨 WITHOUT THIS BLOCK NOBODY GETS IN. Caddy Security completes the password`,
    `\t\t\t# checkpoint, parks the user at /auth/sandbox/<id>, and never issues a token —`,
    `\t\t\t# so the next request to a gated app logs \`no token found\` and loops back to`,
    `\t\t\t# the portal. Authentication succeeds and access is still impossible, with`,
    `\t\t\t# nothing in the logs naming the cause. Measured on a VM 2026-08-12; adding`,
    `\t\t\t# this changes the landing to /auth/portal and a token is issued.`,
    `\t\t\ttransform user {`,
    `\t\t\t\tmatch origin ${primary?.realm ?? "local"}`,
    `\t\t\t\taction add role authp/user`,
    `\t\t\t}`,
    `\t\t}`,
    "",
    // 🚨 Must be INSIDE security {}. As a sibling global option Caddy reports
    // `unrecognized global option: authorization` and refuses to start.
    `\t\timport /etc/caddy/security/policies/*.caddy`,
    `\t}`,
  );
  return lines.join("\n");
}

/**
 * Environment entries the edge container needs so `{env.…}` placeholders resolve.
 *
 * Returned as reference URIs — the caller resolves them through the normal secret path so
 * edge credentials travel exactly like every other secret, with no second mechanism.
 */
export function edgeSecretEnvMapping(config: EdgeIdentityConfig): Array<{ envVar: string; ref: string }> {
  const out: Array<{ envVar: string; ref: string }> = [];
  for (const p of config.providers) {
    // ⚠️ Narrow on `type`, not on "did edgeSecretEnvVar return something". Inferring the
    // provider shape from a helper's truthiness is an undocumented contract: add a
    // fourth provider that needs no secret and this silently reads the wrong field.
    if (p.type === "local") continue;
    const envVar = edgeSecretEnvVar(p);
    if (!envVar) continue;
    out.push({ envVar, ref: p.type === "ldap" ? p.bindPasswordRef : p.clientSecretRef });
  }
  return out;
}
