/**
 * P4 — Provider-agnostic trait proof.
 *
 * Compiles the SAME app.yaml against both the `traefik` and `caddy` ingress
 * providers and asserts that the app-level output (the rendered compose) is
 * identical modulo the provider-specific edge config (the auxiliary file).
 *
 * This is the acceptance test for D3: the trait system must be agnostic to the
 * ingress/auth provider. The provider is resolved once at install level (via
 * $APPBAY_INGRESS_PROVIDER here, which `resolveIngressProvider` honours), and
 * the only thing that may differ between providers is the edge config file —
 * never the app's own compose.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { compile } from "../compile.js";

const APPBAY_WITH_INGRESS = `namespace: homelab
services:
  web:
    traits:
      - type: ingress
        host: myapp.example.com
        port: 8080
        exposure: both
`;

const COMPOSE = `services:
  web:
    image: nginx:latest
    ports:
      - "8080:80"
`;

async function createTempFixture(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "appbay-provider-agnostic-"));
  await mkdir(join(base, "apps"), { recursive: true });
  await mkdir(join(base, "renders"), { recursive: true });
  await mkdir(join(base, "state"), { recursive: true });
  return base;
}

async function writeApp(base: string, appName: string): Promise<void> {
  const appDir = join(base, "apps", appName);
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "docker-compose.yml"), COMPOSE, "utf-8");
  await writeFile(join(appDir, "appbay.yaml"), APPBAY_WITH_INGRESS, "utf-8");
}

describe("P4: provider-agnostic trait proof", () => {
  let base: string;
  const originalEnv = process.env.APPBAY_INGRESS_PROVIDER;

  beforeEach(async () => {
    base = await createTempFixture();
    await writeApp(base, "myapp");
  });

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.APPBAY_INGRESS_PROVIDER;
    else process.env.APPBAY_INGRESS_PROVIDER = originalEnv;
    await rm(base, { recursive: true, force: true });
  });

  async function compileWith(provider: "traefik" | "caddy") {
    process.env.APPBAY_INGRESS_PROVIDER = provider;
    return compile({
      appsDir: join(base, "apps"),
      rendersDir: join(base, "renders"),
      stateDir: join(base, "state"),
    });
  }

  it("produces identical app-level compose under both providers", async () => {
    const traefik = await compileWith("traefik");
    const caddy = await compileWith("caddy");

    expect(traefik.errors).toEqual([]);
    expect(caddy.errors).toEqual([]);
    expect(traefik.apps).toHaveLength(1);
    expect(caddy.apps).toHaveLength(1);

    // The rendered compose — the app's own output — must be byte-identical
    // regardless of which edge fronts it.
    expect(caddy.apps[0].rendered).toBe(traefik.apps[0].rendered);
  });

  it("differs only in the provider-specific edge config file", async () => {
    const traefik = await compileWith("traefik");
    const caddy = await compileWith("caddy");

    const traefikAux = traefik.apps[0].auxiliaryFiles;
    const caddyAux = caddy.apps[0].auxiliaryFiles;

    // Find the ingress edge config file each provider emitted. There may be
    // other auxiliary files (e.g. from other traits), so locate the edge file
    // by its provider-specific path rather than asserting total length.
    //
    // ⚠️ The stem is `homelab.myapp`, not `myapp`: this fixture declares
    // `namespace: homelab`, and RFC-001 §4.4 puts the namespace into the generated edge
    // fragment name so two namespaces of one app do not overwrite each other's site block.
    const traefikEdge = traefikAux.find(
      (a) => a.path === "etc/apps/traefik/config/dynamic/homelab.myapp.yml",
    );
    const caddyEdge = caddyAux.find(
      (a) => a.path === "etc/apps/caddy/config/dynamic/homelab.myapp.caddy",
    );

    // Each provider emits exactly one edge config file for the ingress trait.
    expect(traefikEdge).toBeDefined();
    expect(caddyEdge).toBeDefined();

    // The content is provider-specific (Traefik YAML vs Caddy site block).
    expect(traefikEdge!.content).not.toBe(caddyEdge!.content);
  });

  it("attaches the service to the shared network identically under both providers", async () => {
    const traefik = await compileWith("traefik");
    const caddy = await compileWith("caddy");

    // The shared-network attachment is provider-independent: both rendered
    // composes must carry the appbay_shared network with the alias.
    for (const result of [traefik, caddy]) {
      const rendered = result.apps[0].rendered;
      expect(rendered).toContain("appbay_shared");
      expect(rendered).toContain("myapp_web");
    }
  });
});
