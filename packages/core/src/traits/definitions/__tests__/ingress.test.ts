/**
 * Tests for the ingress trait transform.
 *
 * Verifies that the ingress trait generates correct Traefik dynamic config
 * YAML as an auxiliary file, attaches services to appbay_shared network,
 * and handles exposure modes correctly.
 */

import { describe, it, expect } from "vitest";
import { parse as yamlParse } from "yaml";
import {
  ingressTraitDefinition,
  buildTraefikConfig,
  traefikAuxPath,
  routerName,
  certResolverName,
} from "../ingress.js";
import type { TraitTransformInput } from "../../types.js";
import type { IngressTrait } from "../../../schemas/appbay-yaml.js";

function makeInput(
  overrides: Partial<TraitTransformInput> & { properties: IngressTrait },
): TraitTransformInput {
  return {
    app: "myapp",
    // Traits under test read siblings via input.siblingTraits; default to none.
    siblingTraits: [],
    service: "web",
    compose: { services: { web: { image: "nginx" } } },
    context: {
      project: "default",
      environment: "default",
      appName: "myapp",
      appsDir: "/opt/appbay/etc/apps",
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

describe("Ingress trait transform", () => {
  it("generates auxiliary file with Traefik config", () => {
    const input = makeInput({
      properties: { type: "ingress", host: "chat.example.com", port: 8080, exposure: "both" },
    });
    const result = ingressTraitDefinition.transform(input);

    expect(result.auxiliaryFiles).toHaveLength(1);
    const config = yamlParse(result.auxiliaryFiles![0].content);
    expect(config.http).toBeDefined();
    expect(config.http.routers).toBeDefined();
    expect(config.http.services).toBeDefined();
  });

  it("router rule uses Host matcher with correct hostname", () => {
    const input = makeInput({
      properties: { type: "ingress", host: "chat.example.com", port: 8080, exposure: "external" },
    });
    const result = ingressTraitDefinition.transform(input);
    const config = yamlParse(result.auxiliaryFiles![0].content);
    const routerKeys = Object.keys(config.http.routers);
    const mainRouter = config.http.routers[routerKeys[0]];
    expect(mainRouter.rule).toBe("Host(`chat.example.com`)");
  });

  it("uses letsencrypt certResolver by default", () => {
    const input = makeInput({
      properties: { type: "ingress", host: "app.example.com", port: 80, exposure: "external" },
    });
    const result = ingressTraitDefinition.transform(input);
    const config = yamlParse(result.auxiliaryFiles![0].content);
    const routerKeys = Object.keys(config.http.routers);
    const router = config.http.routers[routerKeys[0]];
    expect(router.tls.certResolver).toBe("letsencrypt");
  });

  it("uses letsencrypt-staging when staging is true", () => {
    const input = makeInput({
      properties: { type: "ingress", host: "app.example.com", port: 80, exposure: "external", tls: { staging: true } },
    });
    const result = ingressTraitDefinition.transform(input);
    const config = yamlParse(result.auxiliaryFiles![0].content);
    const routerKeys = Object.keys(config.http.routers);
    const router = config.http.routers[routerKeys[0]];
    expect(router.tls.certResolver).toBe("letsencrypt-staging");
  });

  it("exposure 'external' generates websecure entrypoint only", () => {
    const input = makeInput({
      properties: { type: "ingress", host: "ext.example.com", port: 443, exposure: "external" },
    });
    const result = ingressTraitDefinition.transform(input);
    const config = yamlParse(result.auxiliaryFiles![0].content);
    const routers = config.http.routers;
    const routerValues = Object.values(routers) as Array<{ entryPoints: string[] }>;
    // All routers should use websecure
    for (const r of routerValues) {
      expect(r.entryPoints).toContain("websecure");
    }
    // No web-only router
    const webOnly = routerValues.filter(r => r.entryPoints.includes("web") && !r.entryPoints.includes("websecure"));
    expect(webOnly).toHaveLength(0);
  });

  it("exposure 'both' generates websecure and web entrypoints", () => {
    const input = makeInput({
      properties: { type: "ingress", host: "both.example.com", port: 8080, exposure: "both" },
    });
    const result = ingressTraitDefinition.transform(input);
    const config = yamlParse(result.auxiliaryFiles![0].content);
    const routerKeys = Object.keys(config.http.routers);
    // Should have at least 2 routers (websecure + web)
    expect(routerKeys.length).toBeGreaterThanOrEqual(2);
    const entryPoints = routerKeys.flatMap(k => config.http.routers[k].entryPoints);
    expect(entryPoints).toContain("websecure");
    expect(entryPoints).toContain("web");
  });

  it("service URL uses appName_service:port format", () => {
    const input = makeInput({
      properties: { type: "ingress", host: "app.example.com", port: 8080, exposure: "external" },
    });
    const result = ingressTraitDefinition.transform(input);
    const config = yamlParse(result.auxiliaryFiles![0].content);
    const serviceKeys = Object.keys(config.http.services);
    const svc = config.http.services[serviceKeys[0]];
    expect(svc.loadBalancer.servers[0].url).toBe("http://myapp_web:8080");
  });

  it("custom port reflected in service URL", () => {
    const input = makeInput({
      app: "jellyfin",
      service: "jellyfin",
      properties: { type: "ingress", host: "media.example.com", port: 8096, exposure: "external" },
      context: {
        project: "default", environment: "default", appName: "jellyfin",
        appsDir: "/opt/appbay/etc/apps",
        runtimeFacts: {
          gpu: { available: false, cdiSupported: false },
          docker: { version: "24.0.7", composeVersion: "2.23.3", socketPath: "/var/run/docker.sock" },
          os: { platform: "linux", arch: "x64", version: "6.5.0" },
          disk: { availableGb: 100, totalGb: 500 },
          operatorId: "local",
        },
      },
    });
    const result = ingressTraitDefinition.transform(input);
    const config = yamlParse(result.auxiliaryFiles![0].content);
    const serviceKeys = Object.keys(config.http.services);
    const svc = config.http.services[serviceKeys[0]];
    expect(svc.loadBalancer.servers[0].url).toBe("http://jellyfin_jellyfin:8096");
  });

  it("auxiliary file path targets traefik config dynamic directory", () => {
    const input = makeInput({
      properties: { type: "ingress", host: "app.example.com", port: 80, exposure: "both" },
    });
    const result = ingressTraitDefinition.transform(input);
    expect(result.auxiliaryFiles![0].path).toBe("etc/apps/traefik/config/dynamic/myapp.yml");
  });

  it("attaches target service to appbay_shared network (no existing networks)", () => {
    const input = makeInput({
      properties: { type: "ingress", host: "app.example.com", port: 80, exposure: "both" },
    });
    const result = ingressTraitDefinition.transform(input);
    const compose = result.compose as {
      services: Record<string, { networks?: unknown }>;
      networks: Record<string, unknown>;
    };
    const webSvc = compose.services.web;
    expect(webSvc.networks).toBeDefined();
    expect(webSvc.networks).toHaveProperty("appbay_shared");
    expect((webSvc.networks as Record<string, { aliases: string[] }>).appbay_shared.aliases)
      .toContain("myapp_web");
    expect(compose.networks.appbay_shared).toEqual({ external: true });
  });

  it("appends appbay_shared to existing array-form networks", () => {
    const input = makeInput({
      compose: { services: { web: { image: "nginx", networks: ["mynet"] } } },
      properties: { type: "ingress", host: "app.example.com", port: 80, exposure: "external" },
    });
    const result = ingressTraitDefinition.transform(input);
    const compose = result.compose as { services: Record<string, { networks: Record<string, unknown> }> };
    expect(compose.services.web.networks).toHaveProperty("mynet");
    expect(compose.services.web.networks).toHaveProperty("appbay_shared");
  });

  it("does not duplicate appbay_shared when it already exists in array networks", () => {
    const input = makeInput({
      compose: { services: { web: { image: "nginx", networks: ["appbay_shared", "custom"] } } },
      properties: { type: "ingress", host: "app.example.com", port: 80, exposure: "external" },
    });
    const result = ingressTraitDefinition.transform(input);
    const compose = result.compose as { services: Record<string, { networks: Record<string, unknown> }> };
    const count = Object.keys(compose.services.web.networks).filter((n) => n === "appbay_shared").length;
    expect(count).toBe(1);
  });

  it("extends object-form networks with appbay_shared key", () => {
    const input = makeInput({
      compose: { services: { web: { image: "nginx", networks: { mynet: { aliases: ["web"] } } } } },
      properties: { type: "ingress", host: "app.example.com", port: 80, exposure: "external" },
    });
    const result = ingressTraitDefinition.transform(input);
    const compose = result.compose as { services: Record<string, { networks: Record<string, unknown> }> };
    expect(compose.services.web.networks).toHaveProperty("mynet");
    expect(compose.services.web.networks).toHaveProperty("appbay_shared");
    expect((compose.services.web.networks.appbay_shared as { aliases: string[] }).aliases)
      .toContain("myapp_web");
  });

  it("does not duplicate appbay_shared when it already exists in object networks", () => {
    const input = makeInput({
      compose: { services: { web: { image: "nginx", networks: { appbay_shared: {}, other: {} } } } },
      properties: { type: "ingress", host: "app.example.com", port: 80, exposure: "external" },
    });
    const result = ingressTraitDefinition.transform(input);
    const compose = result.compose as { services: Record<string, { networks: Record<string, unknown> }> };
    const keys = Object.keys(compose.services.web.networks);
    const count = keys.filter((k) => k === "appbay_shared").length;
    expect(count).toBe(1);
  });

  it("skips network attachment when service is undefined (compose returned unchanged)", () => {
    const originalCompose = { services: { web: { image: "nginx" } } };
    const input = makeInput({
      service: undefined,
      compose: originalCompose,
      properties: { type: "ingress", host: "app.example.com", port: 80, exposure: "external" },
    });
    const result = ingressTraitDefinition.transform(input);

    // No network should have been added — compose is the same shape as input.
    const services = result.compose.services as Record<string, Record<string, unknown>>;
    expect(services.web?.networks).toBeUndefined();
  });

  it("exposure 'internal' generates websecure entrypoint only (no plain-web router)", () => {
    const input = makeInput({
      properties: { type: "ingress", host: "internal.example.com", port: 8080, exposure: "internal" },
    });
    const result = ingressTraitDefinition.transform(input);
    const config = yamlParse(result.auxiliaryFiles![0].content);
    const routers = config.http.routers;
    const routerValues = Object.values(routers) as Array<{ entryPoints: string[] }>;
    // websecure must be present
    expect(routerValues.some((r) => r.entryPoints.includes("websecure"))).toBe(true);
    // plain web entrypoint must NOT be present (no HTTP redirect for internal-only)
    const webOnlyRouters = routerValues.filter(
      (r) => r.entryPoints.includes("web") && !r.entryPoints.includes("websecure"),
    );
    expect(webOnlyRouters).toHaveLength(0);
    // Exactly one router for internal mode
    expect(routerValues).toHaveLength(1);
  });

  it("includes secure-headers middleware", () => {
    const input = makeInput({
      properties: { type: "ingress", host: "app.example.com", port: 80, exposure: "external" },
    });
    const result = ingressTraitDefinition.transform(input);
    const config = yamlParse(result.auxiliaryFiles![0].content);
    expect(config.http.middlewares).toBeDefined();
    const mwKeys = Object.keys(config.http.middlewares);
    expect(mwKeys.length).toBeGreaterThan(0);
    const mw = config.http.middlewares[mwKeys[0]];
    expect(mw.headers.stsSeconds).toBeDefined();
  });
});

describe("buildTraefikConfig helper", () => {
  it("returns well-structured Traefik config object", () => {
    const config = buildTraefikConfig("myapp", "web", {
      type: "ingress", host: "app.example.com", port: 3000, exposure: "both",
    });
    expect(config.http).toBeDefined();
    expect((config.http as Record<string, unknown>).routers).toBeDefined();
    expect((config.http as Record<string, unknown>).services).toBeDefined();
    expect((config.http as Record<string, unknown>).middlewares).toBeDefined();
  });
});

describe("traefikAuxPath helper", () => {
  it("returns APPBAY_HOME-relative path in traefik config dynamic dir", () => {
    expect(traefikAuxPath("jellyfin")).toBe("etc/apps/traefik/config/dynamic/jellyfin.yml");
  });
});

// ---------------------------------------------------------------------------
// routerName helper
// ---------------------------------------------------------------------------

describe("routerName", () => {
  it("returns app name alone when no service given", () => {
    expect(routerName("myapp")).toBe("myapp");
  });

  it("joins app and service with hyphen", () => {
    expect(routerName("myapp", "web")).toBe("myapp-web");
  });

  it("replaces underscores with hyphens", () => {
    expect(routerName("my_app", "web_svc")).toBe("my-app-web-svc");
  });

  it("replaces dots with hyphens", () => {
    expect(routerName("app.v2", "api.v1")).toBe("app-v2-api-v1");
  });

  it("replaces spaces with hyphens", () => {
    expect(routerName("my app")).toBe("my-app");
  });

  it("preserves existing hyphens", () => {
    expect(routerName("my-app", "my-service")).toBe("my-app-my-service");
  });

  it("preserves alphanumeric characters", () => {
    expect(routerName("app123", "svc456")).toBe("app123-svc456");
  });

  it("handles app name only with special chars", () => {
    expect(routerName("open_webui")).toBe("open-webui");
  });

  it("replaces consecutive special chars with consecutive hyphens (each char → hyphen)", () => {
    // Each non-alphanumeric char is replaced individually, so "__" → "--"
    expect(routerName("app__v2")).toBe("app--v2");
  });

  it("does not strip leading hyphens from app name passed with leading hyphen", () => {
    // The function sanitizes but does not strip leading/trailing hyphens — caller is responsible
    expect(routerName("-app")).toBe("-app");
  });
});

// ---------------------------------------------------------------------------
// certResolverName helper
// ---------------------------------------------------------------------------

describe("certResolverName", () => {
  it("returns 'letsencrypt' when tls is undefined", () => {
    expect(certResolverName(undefined)).toBe("letsencrypt");
  });

  it("returns 'letsencrypt-staging' when staging is true", () => {
    expect(certResolverName({ staging: true })).toBe("letsencrypt-staging");
  });

  it("returns 'letsencrypt' when staging is false", () => {
    expect(certResolverName({ staging: false })).toBe("letsencrypt");
  });
});

// ---------------------------------------------------------------------------
// Caddy provider
// ---------------------------------------------------------------------------

describe("caddy ingress provider", () => {
  const props = ingressTraitDefinition.schema.parse({
    type: "ingress",
    host: "grafana.example.com",
    port: 3000,
  }) as IngressTrait;

  function caddyOutput() {
    const input = makeInput({ properties: props });
    return ingressTraitDefinition.transform({
      ...input,
      context: { ...input.context, ingressProvider: "caddy" },
    });
  }

  it("emits a .caddy site block instead of Traefik YAML", () => {
    const files = caddyOutput().auxiliaryFiles!;
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("etc/apps/caddy/config/dynamic/myapp.caddy");
    expect(files[0].content).toContain("grafana.example.com {");
    expect(files[0].content).toContain("reverse_proxy myapp_web:3000");
  });

  it("imports the auth fragment glob above reverse_proxy", () => {
    // ⭐ The glob is what makes cross-file composition work the way Traefik's
    // reference-a-middleware-by-name does, and it is valid with ZERO matches —
    // verified against caddy 2-alpine. So an app with no auth trait needs no
    // placeholder file.
    // ⚠️ Order is semantic in Caddy: forward_auth must precede reverse_proxy or the
    // upstream is not gated.
    const content = caddyOutput().auxiliaryFiles![0].content;
    const importIdx = content.indexOf("import auth/myapp-*.caddy");
    const proxyIdx = content.indexOf("reverse_proxy");
    expect(importIdx).toBeGreaterThan(-1);
    expect(proxyIdx).toBeGreaterThan(importIdx);
  });

  it("does not emit a site block per file — exactly one owner", () => {
    // Two files declaring the same site address is `ambiguous site definition`, so
    // only this trait may open the block.
    const content = caddyOutput().auxiliaryFiles![0].content;
    expect(content.match(/^\S+ \{$/gm)).toHaveLength(1);
  });

  it("leaves the compose fragment provider-independent", () => {
    // Shared-network attachment and port stripping must not differ by proxy.
    const input = makeInput({ properties: props });
    const traefik = ingressTraitDefinition.transform(input);
    const caddy = ingressTraitDefinition.transform({
      ...input,
      context: { ...input.context, ingressProvider: "caddy" },
    });
    expect(caddy.compose).toEqual(traefik.compose);
  });

  it("still emits Traefik YAML when the provider is unset", () => {
    const files = ingressTraitDefinition.transform(
      makeInput({ properties: props }),
    ).auxiliaryFiles!;
    expect(files[0].path).toBe("etc/apps/traefik/config/dynamic/myapp.yml");
  });
});
