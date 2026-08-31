/**
 * The edge security block renderer — RFC-001 §1, task 5.1.
 *
 * ⭐ WHY BYTE-FOR-BYTE AND NOT "CONTAINS THE IMPORTANT BITS". This renderer is destined to
 * REPLACE the hand-written block in the shipped Caddyfile. Every way the two can differ is a
 * silent failure — the edge starts, the config parses, and nobody can log in — so the only
 * assertion that makes the replacement safe is that for the default configuration the output
 * is the shipped text exactly. A `toContain` suite would have passed against the draft this
 * replaced, which was wrong in four separate ways.
 *
 * It reads the SHIPPED file rather than a copy, for the reason `caddy-edge-contract.test.ts`
 * gives: asserting a renderer against a renderer proves nothing about what deploys.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EdgeIdentityConfigSchema } from "../../schemas/edge-identity-providers.js";
import {
  edgeSecretEnvMapping,
  edgeSecretEnvVar,
  renderEdgeSecurityBlock,
} from "../edge-portal-config.js";

const CADDYFILE = readFileSync(
  join(__dirname, "..", "..", "..", "..", "..", "system-apps", "caddy", "config", "Caddyfile"),
  "utf-8",
);

/** The `security { … }` block as it actually ships, tabs and blank lines included. */
function shippedSecurityBlock(): string {
  const start = CADDYFILE.indexOf("\tsecurity {");
  if (start === -1) throw new Error("no `security {` block in the shipped Caddyfile");
  const end = CADDYFILE.indexOf("\n\t}", start);
  if (end === -1) throw new Error("unterminated `security {` block in the shipped Caddyfile");
  return CADDYFILE.slice(start, end + "\n\t}".length);
}

const DEFAULT_CONFIG = EdgeIdentityConfigSchema.parse({});

describe("the default configuration reproduces the shipped block", () => {
  it("matches byte for byte", () => {
    // If this fails, wiring the renderer in would CHANGE a working edge. Fix the renderer,
    // or change the shipped file deliberately and update this in the same commit.
    expect(renderEdgeSecurityBlock(DEFAULT_CONFIG)).toBe(shippedSecurityBlock());
  });

  it("names the store appbay_local, which is what `enable identity store` takes", () => {
    // The store NAME and the REALM are different identifiers; the draft used the realm for
    // both and produced `local identity store local`.
    const out = renderEdgeSecurityBlock(DEFAULT_CONFIG);
    expect(out).toContain("local identity store appbay_local {");
    expect(out).toContain("enable identity store appbay_local");
    expect(out).toContain("\t\t\trealm local");
  });

  it("points the local store at the mounted volume, not /config", () => {
    // `./config/security` is mounted at `/etc/caddy/security`. `/config` is the separate
    // anonymous `caddy-config` volume — a store there is written by nothing.
    expect(renderEdgeSecurityBlock(DEFAULT_CONFIG)).toContain(
      "path /etc/caddy/security/users.json",
    );
    expect(renderEdgeSecurityBlock(DEFAULT_CONFIG)).not.toContain("/config/security");
  });

  it("names the portal appbay_portal, which is what the auth trait references", () => {
    // `auth.ts:57` emits `authenticate * with appbay_portal`.
    expect(renderEdgeSecurityBlock(DEFAULT_CONFIG)).toContain(
      "authentication portal appbay_portal {",
    );
  });

  it("emits the signing key the per-app fragments verify against", () => {
    // `auth.ts:42` emits the matching `crypto key verify {$APPBAY_EDGE_TOKEN_SECRET}`.
    expect(renderEdgeSecurityBlock(DEFAULT_CONFIG)).toContain(
      "crypto key sign-verify {$APPBAY_EDGE_TOKEN_SECRET}",
    );
  });

  it("imports the authorization policies from INSIDE the security block", () => {
    // As a sibling global option Caddy reports `unrecognized global option: authorization`
    // and refuses to start, so position is the assertion, not presence.
    const out = renderEdgeSecurityBlock(DEFAULT_CONFIG);
    expect(out.trimEnd().endsWith("import /etc/caddy/security/policies/*.caddy\n\t}")).toBe(true);
  });

  it("keeps the transform block without which nobody gets a token (#68)", () => {
    expect(renderEdgeSecurityBlock(DEFAULT_CONFIG)).toMatch(/transform user \{/);
  });
});

describe("additional providers ADD to the default, they do not replace it", () => {
  const withLdap = EdgeIdentityConfigSchema.parse({
    providers: [
      { type: "local", realm: "local" },
      {
        type: "ldap",
        realm: "corp",
        servers: ["ldaps://dc1.corp.example.org"],
        bindDn: "CN=svc,OU=Svc,DC=corp,DC=example,DC=org",
        bindPasswordRef: "vault://edge/LDAP_BIND?",
        searchBaseDn: "DC=corp,DC=example,DC=org",
        searchUserFilter: "(&(sAMAccountName=%s)(objectclass=user))",
        groupRoleMap: { "CN=Admins,DC=corp,DC=example,DC=org": ["authp/admin"] },
      },
    ],
  });

  it("still carries every load-bearing line from the default block", () => {
    const out = renderEdgeSecurityBlock(withLdap);
    for (const required of [
      "local identity store appbay_local {",
      "path /etc/caddy/security/users.json",
      "authentication portal appbay_portal {",
      "crypto key sign-verify {$APPBAY_EDGE_TOKEN_SECRET}",
      "transform user {",
      "import /etc/caddy/security/policies/*.caddy",
    ]) {
      expect(out).toContain(required);
    }
  });

  it("declares the ldap store and keeps the FIRST provider primary", () => {
    const out = renderEdgeSecurityBlock(withLdap);
    expect(out).toContain("ldap identity store appbay_corp {");
    // Order is load-bearing — a broad provider listed first shadows a narrower one after it.
    expect(out).toContain("enable identity store appbay_local");
    expect(out.indexOf("appbay_local {")).toBeLessThan(out.indexOf("appbay_corp {"));
  });

  it("renders the bind password as an env placeholder, never as a value", () => {
    // Rendering the value would put a bind password in var/lib/renders/**, on disk and in
    // the plan diff.
    const out = renderEdgeSecurityBlock(withLdap);
    expect(out).toContain('password "{env.EDGE_LDAP_BIND_PASSWORD_CORP}"');
    expect(out).not.toContain("vault://");
  });

  it("maps that placeholder back to the reference for the deploy path", () => {
    expect(edgeSecretEnvMapping(withLdap)).toEqual([
      { envVar: "EDGE_LDAP_BIND_PASSWORD_CORP", ref: "vault://edge/LDAP_BIND?" },
    ]);
  });

  it("a local-only configuration needs no secret env at all", () => {
    expect(edgeSecretEnvMapping(DEFAULT_CONFIG)).toEqual([]);
    expect(edgeSecretEnvVar({ type: "local", realm: "local" })).toBeNull();
  });
});
