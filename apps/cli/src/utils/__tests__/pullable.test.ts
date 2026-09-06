/**
 * A built image is never asked of the registry. The render has had `build:` stripped, so the
 * answer comes from the manifest and the upstream compose (S48 round 5).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullableServices } from "../pullable.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "appbay-pullable-"));
  writeFileSync(join(dir, "render.yml"), "services:\n  caddy:\n    image: localhost/appbay-caddy-security:1\n  whoami:\n    image: traefik/whoami\n  builder:\n    image: local/thing\n");
  // Shaped like system-apps/caddy: the upstream has both `build:` and an `image:` default.
  writeFileSync(join(dir, "upstream.yml"), "services:\n  caddy:\n    build: ./config\n    image: ${APPBAY_CADDY_IMAGE:-localhost/appbay-caddy-security:1}\n  whoami:\n    image: traefik/whoami\n  builder:\n    build: .\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pullableServices", () => {
  it("excludes a service whose render is pinned to the manifest build's image, and one the upstream compose builds", () => {
    expect(pullableServices(join(dir, "render.yml"), join(dir, "upstream.yml"), { caddy: { context: ".", image: "localhost/appbay-caddy-security:1" } })).toEqual(["whoami"]);
  });
  it("a manifest build gated off by when: left the compose's own image in the render, and that one is pullable", () => {
    // The compiler consults `builds.caddy` because the upstream has `build:`; gated off, the render keeps the upstream image.
    writeFileSync(join(dir, "render-gated.yml"), "services:\n  caddy:\n    image: ${APPBAY_CADDY_IMAGE:-localhost/appbay-caddy-security:1}\n  whoami:\n    image: traefik/whoami\n");
    expect(pullableServices(join(dir, "render-gated.yml"), join(dir, "upstream.yml"), { caddy: { context: ".", image: "localhost/appbay-caddy-security:gpu", when: { instance: { gpu: true } } } })).toEqual(["caddy", "whoami"]);
  });
  it("with no builds anywhere, every rendered service is pullable", () => {
    writeFileSync(join(dir, "plain.yml"), "services:\n  a:\n    image: x\n  b:\n    image: y\n");
    expect(pullableServices(join(dir, "plain.yml"), join(dir, "plain.yml"), undefined)).toEqual(["a", "b"]);
  });
  it("an unreadable file is null, so the caller can say so rather than 'nothing to pull'", () => {
    expect(pullableServices(join(dir, "missing.yml"), join(dir, "missing.yml"), undefined)).toBeNull();
  });
});
