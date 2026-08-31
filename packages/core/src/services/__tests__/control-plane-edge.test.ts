/**
 * The edge's route to the control plane — RFC-001 §1, spec task 5.1c part two.
 *
 * ⭐ THE POINT OF THESE IS THE COUPLINGS, not the strings. Each fragment names something
 * emitted by a DIFFERENT file — the portal name, the policy name, the network alias, the
 * signing key — and a mismatch in any of them produces an edge that starts, parses and lets
 * nobody in. So the assertions are mostly "this file agrees with that one".
 */

import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_ALIAS,
  CONTROL_PLANE_APP,
  CONTROL_PLANE_PORT,
  controlPlaneEdgeFragments,
  controlPlaneHost,
} from "../control-plane-edge.js";

const HOST = "appbay.example.org";

function fragments(host = HOST): Record<string, string> {
  return Object.fromEntries(controlPlaneEdgeFragments(host).map((f) => [f.path, f.content]));
}

describe("controlPlaneHost", () => {
  it("derives appbay.<domain> from the installation domain", () => {
    expect(controlPlaneHost("example.org")).toBe("appbay.example.org");
  });

  it("lets an explicit server_host win", () => {
    expect(controlPlaneHost("example.org", "ui.example.org")).toBe("ui.example.org");
  });

  it("returns null with no domain — a local install has no name to serve it at", () => {
    // Not an error. Returning a bogus host would emit a site block nobody can reach, and
    // Caddy would try to issue a certificate for it.
    expect(controlPlaneHost(undefined)).toBeNull();
    expect(controlPlaneHost("")).toBeNull();
    expect(controlPlaneHost("   ")).toBeNull();
  });

  it("ignores a blank explicit host rather than serving at an empty name", () => {
    expect(controlPlaneHost("example.org", "  ")).toBe("appbay.example.org");
  });
});

describe("the three fragments", () => {
  it("writes exactly the three files the edge imports, and no others", () => {
    expect(Object.keys(fragments()).sort()).toEqual([
      "etc/apps/caddy/config/dynamic/appbay-server.caddy",
      "etc/apps/caddy/config/dynamic/auth/appbay-server-security.caddy",
      "etc/apps/caddy/config/security/policies/appbay-server.caddy",
    ]);
  });

  it("dials the network ALIAS, not the container name", () => {
    // 🚨 `appbay.server` has dots, which are label separators wherever a name reaches DNS.
    // The server compose declares `appbay_server` on appbay_shared for exactly this.
    const site = fragments()["etc/apps/caddy/config/dynamic/appbay-server.caddy"] as string;
    expect(site).toContain(`reverse_proxy ${CONTROL_PLANE_ALIAS}:${CONTROL_PLANE_PORT}`);
    expect(site).not.toContain("appbay.server");
  });

  it("the site block's auth glob matches the auth fragment's filename", () => {
    // The site imports `auth/<app>-*.caddy`. If the auth fragment were named anything else
    // the glob would match nothing — which Caddy accepts silently, leaving the site UNGATED.
    const site = fragments()["etc/apps/caddy/config/dynamic/appbay-server.caddy"] as string;
    expect(site).toContain(`import auth/${CONTROL_PLANE_APP}-*.caddy`);
    const authFile = "etc/apps/caddy/config/dynamic/auth/appbay-server-security.caddy";
    expect(authFile.split("/").pop()).toMatch(new RegExp(`^${CONTROL_PLANE_APP}-.*\\.caddy$`));
  });

  it("the route's `authorize with` names the policy the policy file defines", () => {
    const route = fragments()[
      "etc/apps/caddy/config/dynamic/auth/appbay-server-security.caddy"
    ] as string;
    const policy = fragments()[
      "etc/apps/caddy/config/security/policies/appbay-server.caddy"
    ] as string;
    const named = /authorize with (\S+)/.exec(route)?.[1];
    expect(named).toBeTruthy();
    expect(policy).toContain(`authorization policy ${named} {`);
  });

  it("authenticates with the portal the shipped Caddyfile actually defines", () => {
    // `appbay_portal`, not `appbay` — the name the security block declares.
    const route = fragments()[
      "etc/apps/caddy/config/dynamic/auth/appbay-server-security.caddy"
    ] as string;
    expect(route).toContain("authenticate * with appbay_portal");
  });

  it("verifies against the same signing key the portal signs with", () => {
    const policy = fragments()[
      "etc/apps/caddy/config/security/policies/appbay-server.caddy"
    ] as string;
    expect(policy).toContain("crypto key verify {$APPBAY_EDGE_TOKEN_SECRET}");
  });

  it("🚨 grants ADMINS ONLY — not every authenticated user", () => {
    // An app's default also allows `authp/user`. The control plane reaches the container
    // runtime socket, so "any authenticated user" is the wrong default for this one stack.
    const policy = fragments()[
      "etc/apps/caddy/config/security/policies/appbay-server.caddy"
    ] as string;
    expect(policy).toContain("allow roles authp/admin");
    expect(policy).not.toContain("authp/user");
  });

  it("points the portal redirect at the host it is served at", () => {
    const policy = fragments("ui.corp.example.com")[
      "etc/apps/caddy/config/security/policies/appbay-server.caddy"
    ] as string;
    expect(policy).toContain("set auth url https://ui.corp.example.com/auth");
  });

  it("serves the site block at the requested host", () => {
    const site = fragments("ui.corp.example.com")[
      "etc/apps/caddy/config/dynamic/appbay-server.caddy"
    ] as string;
    expect(site).toContain("ui.corp.example.com {");
  });
});
