import { describe, it, expect } from "vitest";
import { resolveBuilds, buildApplies, assertVerificationResult } from "../builds.js";
import type { BuildSpec } from "../../schemas/appbay-yaml.js";

const composeWithBuild = () => ({
  services: {
    caddy: {
      image: "docker.io/library/caddy:2-alpine",
      build: { context: ".", dockerfile: "config/Dockerfile.cloudflare" },
      ports: ["80:80"],
    },
    other: { image: "nginx:alpine" },
  },
});

const spec: BuildSpec = {
  image: "localhost/appbay-caddy-cloudflare:2",
  when: { instance: { acme_dns_provider: "cloudflare" } },
  verify: { command: ["caddy", "list-modules"], contains: "dns.providers.cloudflare" },
};

describe("buildApplies", () => {
  it("applies when every declared instance key matches", () => {
    expect(buildApplies(spec, { acme_dns_provider: "cloudflare" })).toBe(true);
  });

  it("does not apply when the key is absent", () => {
    expect(buildApplies(spec, {})).toBe(false);
  });

  it("does not apply when the key has a different value", () => {
    expect(buildApplies(spec, { acme_dns_provider: "route53" })).toBe(false);
  });

  it("applies unconditionally when no when: clause is declared", () => {
    expect(buildApplies({ image: "x:1" }, {})).toBe(true);
  });
});

describe("resolveBuilds", () => {
  it("strips build:, pins image:, and emits one build when the predicate matches", () => {
    const { compose, builds, errors } = resolveBuilds(composeWithBuild(), { caddy: spec }, {
      acme_dns_provider: "cloudflare",
    });

    const caddy = (compose.services as Record<string, Record<string, unknown>>).caddy;
    expect(caddy.build).toBeUndefined();
    expect(caddy.image).toBe("localhost/appbay-caddy-cloudflare:2");
    // Everything else about the service is untouched.
    expect(caddy.ports).toEqual(["80:80"]);
    expect(errors).toEqual([]);
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({
      service: "caddy",
      image: "localhost/appbay-caddy-cloudflare:2",
      context: ".",
      dockerfile: "config/Dockerfile.cloudflare",
    });
  });

  it("🚨 STRIPS build: EVEN WHEN THE BUILD IS GATED OFF, and keeps the stock image", () => {
    // This is the case that matters most and the one easiest to get wrong. An installation
    // with no DNS-01 must not build — and must ALSO not carry a `build:` into the render,
    // because that would put an implicit build back inside `compose up` for exactly the
    // hosts that opted out of building.
    const { compose, builds } = resolveBuilds(composeWithBuild(), { caddy: spec }, {});

    const caddy = (compose.services as Record<string, Record<string, unknown>>).caddy;
    expect(caddy.build).toBeUndefined();
    expect(caddy.image).toBe("docker.io/library/caddy:2-alpine");
    expect(builds).toEqual([]);
  });

  it("leaves services without a build: block completely alone", () => {
    const { compose } = resolveBuilds(composeWithBuild(), { caddy: spec }, {
      acme_dns_provider: "cloudflare",
    });
    expect((compose.services as Record<string, unknown>).other).toEqual({
      image: "nginx:alpine",
    });
  });

  it("does not mutate the input compose", () => {
    const input = composeWithBuild();
    resolveBuilds(input, { caddy: spec }, { acme_dns_provider: "cloudflare" });
    expect(
      (input.services as Record<string, Record<string, unknown>>).caddy.build,
    ).toBeDefined();
  });

  it("errors when a service builds with no manifest entry and no image to fall back to", () => {
    const compose = { services: { thing: { build: { context: "." } } } };
    const { errors, builds } = resolveBuilds(compose, undefined, {});
    expect(builds).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("builds.thing");
  });

  it("accepts compose's short build form", () => {
    const compose = { services: { thing: { image: "a:1", build: "./ctx" } } };
    const { builds } = resolveBuilds(compose, { thing: { image: "b:2" } }, {});
    expect(builds[0]).toMatchObject({ context: "./ctx", image: "b:2" });
  });

  it("normalises build args from both the mapping and the KEY=value list form", () => {
    const asList = { services: { a: { image: "x:1", build: { context: ".", args: ["K=v"] } } } };
    const asMap = { services: { a: { image: "x:1", build: { context: ".", args: { K: "v" } } } } };
    const specs = { a: { image: "y:1" } };
    expect(resolveBuilds(asList, specs, {}).builds[0].args).toEqual({ K: "v" });
    expect(resolveBuilds(asMap, specs, {}).builds[0].args).toEqual({ K: "v" });
  });

  it("carries verify and pull_if_present through to the resolved build", () => {
    const withHatch: BuildSpec = { ...spec, pull_if_present: "ghcr.io/org/caddy-cf:2" };
    const { builds } = resolveBuilds(composeWithBuild(), { caddy: withHatch }, {
      acme_dns_provider: "cloudflare",
    });
    expect(builds[0].verify).toEqual(spec.verify);
    expect(builds[0].pullIfPresent).toBe("ghcr.io/org/caddy-cf:2");
  });
});

describe("assertVerificationResult", () => {
  const build = resolveBuilds(composeWithBuild(), { caddy: spec }, {
    acme_dns_provider: "cloudflare",
  }).builds[0];

  it("reports an image execution failure instead of claiming capabilities are missing", () => {
    expect(() =>
      assertVerificationResult(build, 125, "Error: No such image"),
    ).toThrow(/could not run its declared check[\s\S]*container_runtime can see the image/);
  });

  it("reports missing capabilities only after the probe command succeeds", () => {
    expect(() => assertVerificationResult(build, 0, "http.handlers.reverse_proxy\n")).toThrow(
      /did not produce "dns\.providers\.cloudflare"/,
    );
  });

  it("accepts a successful probe containing every required capability", () => {
    expect(() =>
      assertVerificationResult(build, 0, "dns.providers.cloudflare\n"),
    ).not.toThrow();
  });
});
