/**
 * Tests for the Caddy Security auth trait transform.
 *
 * Verifies that the auth trait generates the Caddy Security authentication route
 * and authorization policy as auxiliary files, requires the Caddy edge, requires a
 * sibling ingress trait with a host, and preserves explicit deny behavior for a
 * successfully authenticated non-member.
 */

import { describe, it, expect } from "vitest";
import {
  authTraitDefinition,
  caddySecurityPolicy,
  caddySecurityRoute,
} from "../auth.js";
import type { TraitTransformInput } from "../../types.js";
import type { AuthTrait } from "../../../schemas/appbay-yaml.js";

function makeInput(
  overrides: Partial<TraitTransformInput> & { properties: AuthTrait },
): TraitTransformInput {
  return {
    app: "myapp",
    siblingTraits: [],
    service: "web",
    compose: { services: { web: { image: "nginx" } } },
    context: {
      project: "default",
      environment: "default",
      appName: "myapp",
      appsDir: "/opt/appbay/etc/apps",
      ingressProvider: "caddy",
      runtimeFacts: {
        gpu: { available: false, cdiSupported: false },
        docker: {
          version: "24.0.7",
          composeVersion: "2.23.3",
          socketPath: "/var/run/docker.sock",
        },
        os: { platform: "linux", arch: "x64", version: "6.5.0" },
        disk: { availableGb: 100, totalGb: 500 },
        operatorId: "local",
      },
    },
    ...overrides,
  };
}

describe("Auth trait transform", () => {
  it("generates the Caddy Security route and policy auxiliary files", () => {
    const input = makeInput({
      properties: { type: "auth", mode: "portal", enabled: true, policy: "authenticated" },
      siblingTraits: [
        { type: "ingress", host: "chat.example.com", port: 8080, service: "web" },
      ],
    });
    const result = authTraitDefinition.transform(input);

    expect(result.errors).toBeUndefined();
    expect(result.auxiliaryFiles).toHaveLength(2);

    const route = result.auxiliaryFiles!.find((file) =>
      file.path.endsWith("-security.caddy"),
    );
    const policy = result.auxiliaryFiles!.find((file) =>
      file.path.endsWith(".caddy") && !file.path.endsWith("-security.caddy"),
    );

    expect(route?.path).toBe(
      "etc/apps/caddy/config/dynamic/auth/myapp-security.caddy",
    );
    expect(route?.content).toContain("authenticate * with appbay_portal");
    expect(route?.content).toContain("authorize with appbay_myapp");

    expect(policy?.path).toBe(
      "etc/apps/caddy/config/security/policies/myapp.caddy",
    );
    expect(policy?.content).toContain("authorization policy appbay_myapp");
    expect(policy?.content).toContain("set auth url https://chat.example.com/auth");
    expect(policy?.content).toContain("inject header \"Remote-User\" from sub");
    expect(policy?.content).toContain("inject header \"Remote-Email\" from email");
    expect(policy?.content).toContain("inject header \"Remote-Groups\" from roles");
  });

  it("defaults to allowing the built-in admin and user roles", () => {
    const input = makeInput({
      properties: { type: "auth", mode: "portal", enabled: true, policy: "authenticated" },
      siblingTraits: [
        { type: "ingress", host: "chat.example.com", port: 8080, service: "web" },
      ],
    });
    const result = authTraitDefinition.transform(input);
    const policy = result.auxiliaryFiles!.find((file) =>
      file.path.endsWith(".caddy") && !file.path.endsWith("-security.caddy"),
    );
    expect(policy?.content).toContain("allow roles authp/admin authp/user");
  });

  it("adds a group role when one is declared", () => {
    const input = makeInput({
      properties: { type: "auth", mode: "portal", enabled: true, policy: "authenticated", group: "admins" },
      siblingTraits: [
        { type: "ingress", host: "chat.example.com", port: 8080, service: "web" },
      ],
    });
    const result = authTraitDefinition.transform(input);
    const policy = result.auxiliaryFiles!.find((file) =>
      file.path.endsWith(".caddy") && !file.path.endsWith("-security.caddy"),
    );
    expect(policy?.content).toContain("allow roles authp/admin authp/admins");
  });

  it("emits an explicit deny for a deny policy", () => {
    const input = makeInput({
      properties: { type: "auth", mode: "portal", enabled: true, policy: "deny" },
      siblingTraits: [
        { type: "ingress", host: "chat.example.com", port: 8080, service: "web" },
      ],
    });
    const result = authTraitDefinition.transform(input);
    const policy = result.auxiliaryFiles!.find((file) =>
      file.path.endsWith(".caddy") && !file.path.endsWith("-security.caddy"),
    );
    expect(policy?.content).toContain("deny");
    expect(policy?.content).not.toContain("allow roles");
  });

  it("fails validation when the edge is not Caddy", () => {
    const input = makeInput({
      properties: { type: "auth", mode: "portal", enabled: true, policy: "authenticated" },
      siblingTraits: [
        { type: "ingress", host: "chat.example.com", port: 8080, service: "web" },
      ],
    });
    input.context.ingressProvider = "traefik";
    const result = authTraitDefinition.transform(input);

    expect(result.auxiliaryFiles).toBeUndefined();
    expect(result.errors).toBeDefined();
    expect(result.errors![0]).toContain("requires the Caddy Security edge");
  });

  it("fails validation without a sibling ingress host", () => {
    const input = makeInput({
      properties: { type: "auth", mode: "portal", enabled: true, policy: "authenticated" },
      siblingTraits: [],
    });
    const result = authTraitDefinition.transform(input);

    expect(result.auxiliaryFiles).toBeUndefined();
    expect(result.errors).toBeDefined();
    expect(result.errors![0]).toContain("sibling ingress trait");
  });

  it("is a no-op when disabled", () => {
    const input = makeInput({
      properties: { type: "auth", mode: "portal", enabled: false, policy: "authenticated" },
      siblingTraits: [
        { type: "ingress", host: "chat.example.com", port: 8080, service: "web" },
      ],
    });
    const result = authTraitDefinition.transform(input);

    expect(result.auxiliaryFiles).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });
});

describe("caddySecurityPolicy", () => {
  it("preserves explicit deny for a successfully authenticated non-member", () => {
    // A non-member authenticates but is not in the allowed roles. The `allow roles`
    // directive denies them; the policy must not silently admit them.
    const policy = caddySecurityPolicy("myapp", "chat.example.com", "authenticated", "admins");
    expect(policy).toContain("allow roles authp/admin authp/admins");
    // The policy is role-gated: an authenticated user outside the roles is denied.
    expect(policy).not.toContain("allow roles authp/user");
  });

  it("emits a deny policy verbatim", () => {
    const policy = caddySecurityPolicy("myapp", "chat.example.com", "deny");
    expect(policy).toContain("deny");
    expect(policy).not.toContain("allow roles");
  });
});

describe("caddySecurityRoute", () => {
  it("mounts the portal and authorizes the app", () => {
    const route = caddySecurityRoute("myapp");
    expect(route).toContain("route /auth*");
    expect(route).toContain("authenticate * with appbay_portal");
    expect(route).toContain("authorize with appbay_myapp");
  });
});
