/**
 * Structural invariants the shipped Caddy edge must satisfy.
 *
 * ⭐ WHY A TEST AND NOT A COMMENT. Each invariant here was a live defect whose failure mode
 * was SILENT — the edge started, reported healthy, and the config parsed. Nothing errored.
 * A comment saying "don't remove this" does not survive a refactor; a failing test does.
 *
 * These read the SHIPPED definition (`system-apps/caddy/config/Caddyfile`), because that is
 * the file that actually gets deployed. Asserting against a renderer that produces the same
 * text would prove nothing about what runs — which is precisely how the transform-block bug
 * survived: the renderer was correct and the deployed file was not.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_APPS } from "../system-apps.js";

const CADDYFILE = readFileSync(
  join(__dirname, "..", "..", "..", "..", "system-apps", "caddy", "config", "Caddyfile"),
  "utf-8",
);

/** The same file as embedded — what `appbay init` actually seeds. */
function embeddedCaddyfile(): string {
  const caddy = SYSTEM_APPS.find((a) => a.name === "caddy");
  if (!caddy) throw new Error("caddy is not in SYSTEM_APPS");
  // `files` is a path -> content record, not an array.
  const content = (caddy.files as Record<string, string>)["config/Caddyfile"];
  if (!content) throw new Error("caddy has no config/Caddyfile among its files");
  return content;
}

describe("shipped Caddy edge contract", () => {
  // 🚨 Regression for #68. Without `transform user`, Caddy Security passes the password
  // checkpoint, parks the user at /auth/sandbox/<id>, and NEVER ISSUES A TOKEN. The next
  // request to a gated app logs `no token found` and loops back to the portal, so
  // authentication succeeds and access is impossible — with nothing naming the cause.
  //
  // The renderer in services/edge-portal-config.ts already emitted this block. The DEPLOYED
  // file did not. That is why this asserts the shipped file.
  it("the portal declares a transform user block, or nobody can log in (#68)", () => {
    expect(CADDYFILE).toMatch(/transform user\s*\{/);
    expect(embeddedCaddyfile()).toMatch(/transform user\s*\{/);
  });

  // The policy import must live INSIDE `security { }`. As a sibling global option Caddy
  // reports `unrecognized global option: authorization` and refuses to start.
  it("imports authorization policies from inside the security block", () => {
    const security = CADDYFILE.slice(CADDYFILE.indexOf("security {"));
    const closing = security.indexOf("\n\t}");
    expect(security.slice(0, closing)).toContain("/etc/caddy/security/policies/*.caddy");
  });

  // Per-app site blocks and auth fragments arrive as import globs, which are valid with
  // zero matches. That is what lets a fresh install with no apps — and an app with no auth
  // trait — start without placeholder files.
  it("imports per-app blocks by glob so zero matches is still valid", () => {
    expect(CADDYFILE).toContain("import /etc/caddy/dynamic/*.caddy");
    expect(CADDYFILE).toContain("import /etc/caddy/global/*.caddy");
  });

  // 🚨 Defining this snippet twice is a hard duplicate-definition error. Every per-app site
  // block emitted by the ingress trait imports it, so it must be defined exactly once here.
  it("defines the shared security-headers snippet exactly once", () => {
    // ⚠️ Count DEFINITIONS, not mentions — the file's own header comment names the
    // snippet while explaining why it may appear only once, and a naive match counts that.
    const definitions = CADDYFILE.split("\n").filter((l) => /^\(appbay_security_headers\)\s*\{/.test(l));
    expect(definitions).toHaveLength(1);
  });

  // The portal and the per-app policies must verify against the same key, or a token issued
  // by the portal is rejected by every policy.
  it("portal signs and policies verify with the same key variable", () => {
    expect(CADDYFILE).toContain("crypto key sign-verify {$APPBAY_EDGE_TOKEN_SECRET}");
  });
});
