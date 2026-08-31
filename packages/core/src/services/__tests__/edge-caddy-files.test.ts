/**
 * Applying edge identity config to caddy's seeded files — RFC-001 §1, task 5.1b.
 *
 * ⭐ THE LOAD-BEARING TEST IS THE FIRST ONE. `applyEdgeIdentity` is called unconditionally
 * when caddy is seeded, so if it changed anything for the default configuration it would
 * rewrite a working edge on every existing installation's next `init --refresh`. Everything
 * else here is secondary to "the default is byte-for-byte a no-op".
 */

import { describe, expect, it } from "vitest";
import { EdgeIdentityConfigSchema } from "../../schemas/edge-identity-providers.js";
import { SYSTEM_APPS } from "../../system-apps.js";
import { EdgeAnchorError, applyEdgeIdentity } from "../edge-caddy-files.js";

function caddyFiles(): Record<string, string> {
  const caddy = SYSTEM_APPS.find((a) => a.name === "caddy");
  if (!caddy) throw new Error("caddy is not in SYSTEM_APPS");
  return caddy.files;
}

const DEFAULT_CONFIG = EdgeIdentityConfigSchema.parse({});

const LDAP_CONFIG = EdgeIdentityConfigSchema.parse({
  providers: [
    { type: "local", realm: "local" },
    {
      type: "ldap",
      realm: "corp",
      servers: ["ldaps://dc1.corp.example.org"],
      bindDn: "CN=svc,OU=Svc,DC=corp,DC=example,DC=org",
      bindPasswordRef: "vault://caddy/LDAP_BIND_PASSWORD",
      searchBaseDn: "DC=corp,DC=example,DC=org",
      searchUserFilter: "(&(sAMAccountName=%s)(objectclass=user))",
      groupRoleMap: { "CN=Admins,DC=corp,DC=example,DC=org": ["authp/admin"] },
    },
  ],
});

describe("the default configuration changes nothing", () => {
  it("returns every file byte for byte", () => {
    // 🚨 If this fails, every existing installation's edge is rewritten on the next refresh.
    const before = caddyFiles();
    expect(applyEdgeIdentity(before, DEFAULT_CONFIG)).toEqual(before);
  });

  it("is stable under repeated application", () => {
    // `init --refresh` runs this every time; a transform that appends would grow the file.
    const before = caddyFiles();
    const once = applyEdgeIdentity(before, DEFAULT_CONFIG);
    expect(applyEdgeIdentity(once, DEFAULT_CONFIG)).toEqual(once);
  });

  it("does not mutate its input", () => {
    const before = caddyFiles();
    const snapshot = { ...before };
    applyEdgeIdentity(before, LDAP_CONFIG);
    expect(before).toEqual(snapshot);
  });
});

describe("an ldap provider reaches all three files", () => {
  const out = applyEdgeIdentity(caddyFiles(), LDAP_CONFIG);

  it("declares the store in the Caddyfile, inside the global options block", () => {
    const caddyfile = out["config/Caddyfile"] as string;
    expect(caddyfile).toContain("ldap identity store appbay_corp {");
    // Position, not presence: the block must stay inside the outer `{ … }` that opens before
    // it, otherwise Caddy reports `unrecognized global option: security` and will not start.
    const globalOpen = caddyfile.indexOf("\n{\n");
    expect(globalOpen).toBeGreaterThan(-1);
    expect(caddyfile.indexOf("ldap identity store")).toBeGreaterThan(globalOpen);
  });

  it("keeps every load-bearing line of the original block", () => {
    const caddyfile = out["config/Caddyfile"] as string;
    for (const required of [
      "local identity store appbay_local {",
      "path /etc/caddy/security/users.json",
      "authentication portal appbay_portal {",
      "crypto key sign-verify {$APPBAY_EDGE_TOKEN_SECRET}",
      "transform user {",
      "import /etc/caddy/security/policies/*.caddy",
    ]) {
      expect(caddyfile).toContain(required);
    }
  });

  it("leaves the rest of the Caddyfile alone", () => {
    const caddyfile = out["config/Caddyfile"] as string;
    // The snippet may be DEFINED exactly once — a second definition is a Caddy parse error.
    // Matched at line start, because the file also names it in prose ("THIS FILE IS THE ONLY
    // PLACE (appbay_security_headers) MAY BE DEFINED"), and a mention is not a definition.
    expect(caddyfile.match(/^\(appbay_security_headers\) \{/gm)).toHaveLength(1);
    expect(caddyfile).toContain("import /etc/caddy/dynamic/*.caddy");
    expect(caddyfile).toContain("order authenticate before respond");
  });

  it("adds the bind password as a REQUIRED secret ref, not an optional one", () => {
    const manifest = out["appbay.yaml"] as string;
    expect(manifest).toContain(
      'EDGE_LDAP_BIND_PASSWORD_CORP: "vault://caddy/LDAP_BIND_PASSWORD"',
    );
    // The ACME credentials are optional because an install may legitimately have none. A
    // configured provider's bind password is not — a portal that starts without it
    // authenticates nobody and says "wrong username or password" to everyone.
    const optionalBlock = manifest.slice(manifest.indexOf("optional:"));
    expect(optionalBlock).not.toContain("EDGE_LDAP_BIND_PASSWORD_CORP");
  });

  it("declares it required in compose so the container refuses to start without it", () => {
    expect(out["docker-compose.yml"]).toContain(
      "- EDGE_LDAP_BIND_PASSWORD_CORP=${EDGE_LDAP_BIND_PASSWORD_CORP:?required}",
    );
  });

  it("never writes the secret VALUE into any seeded file", () => {
    for (const [name, content] of Object.entries(out)) {
      expect(content, `${name} must carry a reference, never a value`).not.toMatch(
        /password\s+"[^{]/,
      );
    }
  });
});

describe("a changed shipped definition fails loudly", () => {
  // A transform that quietly declined to find its anchor would seed an edge with no LDAP
  // provider while reporting success.
  it("throws when the Caddyfile has no security block", () => {
    const broken = { ...caddyFiles(), "config/Caddyfile": "# nothing here\n" };
    expect(() => applyEdgeIdentity(broken, LDAP_CONFIG)).toThrow(EdgeAnchorError);
  });

  it("throws when the secrets trait has no optional: key", () => {
    const broken = { ...caddyFiles(), "appbay.yaml": "services: {}\n" };
    expect(() => applyEdgeIdentity(broken, LDAP_CONFIG)).toThrow(/optional:/);
  });

  it("throws when the compose env anchor is gone", () => {
    const broken = { ...caddyFiles(), "docker-compose.yml": "services: {}\n" };
    expect(() => applyEdgeIdentity(broken, LDAP_CONFIG)).toThrow(/AUTHP_ADMIN_SECRET/);
  });

  it("throws rather than skipping when a file is absent entirely", () => {
    const { "config/Caddyfile": _dropped, ...rest } = caddyFiles();
    expect(() => applyEdgeIdentity(rest, DEFAULT_CONFIG)).toThrow(EdgeAnchorError);
  });
});
