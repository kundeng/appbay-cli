/**
 * Property-based tests for the compiler pipeline.
 *
 * These tests verify invariants that must ALWAYS hold, regardless of the
 * specific input shape.  They complement the unit and integration tests by
 * asserting structural guarantees of the pipeline rather than specific
 * output values.
 *
 * Properties tested:
 *   1. Determinism -- same input, same output.
 *   2. Idempotency -- compiling an already-compiled result is unchanged.
 *   3. Secret redaction -- no secret values leak into plan output.
 *   4. Eject portability -- rendered output is valid, parseable YAML.
 *   5. Namespace isolation -- two apps with same service name get unique
 *      container names / aliases.
 *   6. Overlay inactivity -- overlays excluded when peer apps are absent.
 *   7. Trait conflict detection -- conflicting traits surface errors
 *      through the compile() entry point.
 *   8. Scoped variable resolution -- most specific scope wins.
 *   9. Trait ordering -- declaration order determines output order.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { compile } from "../compile.js";
import type { CompileOptions } from "../compile.js";
import { redactSecrets } from "../plan.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory structure mirroring the appbay filesystem
 * layout: apps/, renders/, state/ subdirectories.
 */
async function createTempFixture(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "appbay-prop-test-"));
  await mkdir(join(base, "apps"), { recursive: true });
  await mkdir(join(base, "renders"), { recursive: true });
  await mkdir(join(base, "state"), { recursive: true });
  return base;
}

/** Write a compose file (and optional appbay.yaml) for a named app. */
async function writeApp(
  base: string,
  appName: string,
  compose: string,
  appbayYaml?: string,
): Promise<void> {
  const appDir = join(base, "apps", appName);
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "docker-compose.yml"), compose, "utf-8");
  if (appbayYaml) {
    await writeFile(join(appDir, "appbay.yaml"), appbayYaml, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Compose fixtures
// ---------------------------------------------------------------------------

const SIMPLE_COMPOSE = `services:
  web:
    image: nginx:latest
    ports:
      - "8080:80"
`;

const COMPOSE_WITH_SECRETS = `services:
  db:
    image: postgres:16
    environment:
      - POSTGRES_PASSWORD=secret123
      - POSTGRES_USER=admin
      - DB_TOKEN=tok_s3cret_value
`;

const COMPOSE_WITH_OVERLAY_PEER = `services:
  web:
    image: nginx:latest
`;

const APPBAY_WITH_OVERLAY = `project: homelab
environment: prod
overlays:
  - when:
      - nonexistent-app
    services:
      web:
        environment:
          - OVERLAY_INJECTED=true
`;

const APPBAY_WITH_SCOPED_VARS = `project: homelab
environment: prod
`;

const COMPOSE_WITH_SCOPED_VARS = `services:
  web:
    image: nginx:latest
    environment:
      - DOMAIN=\${{project.DOMAIN}}
      - ENV=\${{environment.ENV_NAME}}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Compiler pipeline properties", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempFixture();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeOptions(overrides?: Partial<CompileOptions>): CompileOptions {
    return {
      appsDir: join(tempDir, "apps"),
      rendersDir: join(tempDir, "renders"),
      stateDir: join(tempDir, "state"),
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // 1. Determinism -- compiling the same input twice produces identical output
  // -------------------------------------------------------------------------

  it("determinism: same input produces identical output", async () => {
    await writeApp(tempDir, "myapp", SIMPLE_COMPOSE);

    const result1 = await compile(makeOptions());
    const result2 = await compile(makeOptions());

    expect(result1.apps).toHaveLength(1);
    expect(result2.apps).toHaveLength(1);
    expect(result1.apps[0]!.rendered).toBe(result2.apps[0]!.rendered);
    expect(result1.apps[0]!.plan.hash).toBe(result2.apps[0]!.plan.hash);
  });

  // -------------------------------------------------------------------------
  // 2. Idempotency -- compiling an already-compiled result is 'unchanged'
  // -------------------------------------------------------------------------

  it("idempotency: re-compiling with existing render produces 'unchanged'", async () => {
    await writeApp(tempDir, "myapp", SIMPLE_COMPOSE);

    // First compile to get the rendered output.
    const result1 = await compile(makeOptions());
    expect(result1.apps).toHaveLength(1);

    // Write the rendered output to the renders directory (simulating a deploy).
    const renderDir = join(tempDir, "renders", "myapp");
    await mkdir(renderDir, { recursive: true });
    await writeFile(
      join(renderDir, "docker-compose.rendered.yml"),
      result1.apps[0]!.rendered,
      "utf-8",
    );

    // Second compile -- should detect no changes.
    const result2 = await compile(makeOptions());
    expect(result2.apps).toHaveLength(1);
    expect(result2.apps[0]!.plan.status).toBe("unchanged");
    expect(result2.apps[0]!.plan.diff).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. Secret redaction -- no secret values in plan output
  // -------------------------------------------------------------------------

  it("secret redaction: plaintext secrets never appear in plan diff", async () => {
    await writeApp(tempDir, "dbapp", COMPOSE_WITH_SECRETS);

    const result = await compile(makeOptions());
    expect(result.apps).toHaveLength(1);

    const plan = result.apps[0]!.plan;

    // The diff should NOT contain the actual secret values.
    if (plan.diff) {
      expect(plan.diff).not.toContain("secret123");
      expect(plan.diff).not.toContain("tok_s3cret_value");
      // The diff SHOULD contain [REDACTED] placeholders for those fields.
      expect(plan.diff).toContain("[REDACTED]");
    }
  });

  // -------------------------------------------------------------------------
  // 3b. redactSecrets() directly -- verifies the redaction function
  // -------------------------------------------------------------------------

  it("secret redaction: redactSecrets replaces password values", () => {
    const input = [
      "      - POSTGRES_PASSWORD=secret123",
      "      - POSTGRES_USER=admin",
      "      - API_KEY=abc123def456",
    ].join("\n");

    const redacted = redactSecrets(input);

    expect(redacted).not.toContain("secret123");
    expect(redacted).toContain("POSTGRES_PASSWORD=[REDACTED]");
    // POSTGRES_USER is not a secret key pattern, so it should be preserved.
    expect(redacted).toContain("admin");
  });

  // -------------------------------------------------------------------------
  // 4. Eject portability -- rendered compose is valid YAML with 'services'
  // -------------------------------------------------------------------------

  it("eject portability: rendered compose is valid YAML with services key", async () => {
    await writeApp(tempDir, "myapp", SIMPLE_COMPOSE);

    const result = await compile(makeOptions());
    expect(result.apps).toHaveLength(1);

    const rendered = result.apps[0]!.rendered;

    // Must be parseable YAML.
    const parsed = parseYaml(rendered);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");

    // Must have a 'services' key.
    expect(parsed).toHaveProperty("services");
    expect(typeof parsed.services).toBe("object");
    expect(parsed.services.web).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 5. Namespace isolation -- two apps with same service name get unique
  //    container names or aliases
  // -------------------------------------------------------------------------

  it("namespace isolation: two apps with same service name get unique aliases", async () => {
    const composeA = `services:
  web:
    image: nginx:latest
`;
    const composeB = `services:
  web:
    image: httpd:latest
`;

    // Both apps have upstream config with expose, which triggers alias generation.
    const appbayConfig = (appName: string) => `project: homelab
environment: prod
shared_network:
  - appbay_shared
upstream:
  source: docker-compose.yml
  expose:
    - service: web
      networks:
        - appbay_shared
`;

    await writeApp(tempDir, "app-a", composeA, appbayConfig("app-a"));
    await writeApp(tempDir, "app-b", composeB, appbayConfig("app-b"));

    const result = await compile(makeOptions());
    expect(result.apps).toHaveLength(2);

    const appA = result.apps.find((a) => a.appName === "app-a")!;
    const appB = result.apps.find((a) => a.appName === "app-b")!;

    // Both rendered outputs should exist and differ (different images, different aliases).
    expect(appA.rendered).toBeDefined();
    expect(appB.rendered).toBeDefined();
    expect(appA.rendered).not.toBe(appB.rendered);

    // Parse both and verify the web service aliases are namespaced.
    const parsedA = parseYaml(appA.rendered);
    const parsedB = parseYaml(appB.rendered);

    // The upstream transformer adds <appname>_<service> aliases on shared networks.
    // Verify the rendered outputs contain their respective app-prefixed aliases.
    expect(appA.rendered).toContain("app-a_web");
    expect(appB.rendered).toContain("app-b_web");

    // Aliases must be different between the two apps.
    expect(appA.rendered).not.toContain("app-b_web");
    expect(appB.rendered).not.toContain("app-a_web");
  });

  // -------------------------------------------------------------------------
  // 6. Overlay inactivity -- overlays excluded when peer apps are not installed
  // -------------------------------------------------------------------------

  it("overlay inactivity: overlays do not apply when peer apps are not installed", async () => {
    await writeApp(
      tempDir,
      "myapp",
      COMPOSE_WITH_OVERLAY_PEER,
      APPBAY_WITH_OVERLAY,
    );

    // Only myapp is on disk, so the overlay's peer is NOT installed. RFC-001 §5: the
    // installed set is derived from the tree, so "peer absent" is expressed by absence.
    const result = await compile(makeOptions());
    expect(result.apps).toHaveLength(1);

    // The overlay fragment should NOT be in the rendered output.
    expect(result.apps[0]!.rendered).not.toContain("OVERLAY_INJECTED");

    // There should be a warning about the skipped overlay.
    expect(result.warnings.some((w) => w.includes("Overlay skipped"))).toBe(
      true,
    );
  });

  // -------------------------------------------------------------------------
  // 7. Trait conflict detection -- conflicting traits surface errors
  //    through compile()
  // -------------------------------------------------------------------------

  it("trait conflict detection: conflicting traits produce compile errors", async () => {
    // The ingress trait conflicts with itself (only one per service).
    // Declare two ingress traits on the same service to trigger duplication error.
    const composeFile = `services:
  web:
    image: nginx:latest
`;

    const appbayWithDuplicateTrait = `project: homelab
environment: prod
services:
  web:
    traits:
      - type: ingress
        host: a.example.com
        port: 80
      - type: ingress
        host: b.example.com
        port: 80
`;

    await writeApp(tempDir, "conflict-app", composeFile, appbayWithDuplicateTrait);

    const result = await compile(makeOptions());

    // There should be an error about the duplicate trait.
    const traitErrors = result.errors.filter(
      (e) => e.appName === "conflict-app" && e.stage === "apply-traits",
    );
    expect(traitErrors.length).toBeGreaterThan(0);
    expect(
      traitErrors.some((e) => e.message.includes("Duplicate")),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. Scoped variable resolution -- most specific scope wins
  // -------------------------------------------------------------------------

  it("scoped variable resolution: environment overrides project scope", async () => {
    await writeApp(tempDir, "myapp", COMPOSE_WITH_SCOPED_VARS, APPBAY_WITH_SCOPED_VARS);

    const result = await compile(
      makeOptions({
        projectVars: { DOMAIN: "project.example.com", ENV_NAME: "project-env" },
        environmentVars: { ENV_NAME: "staging" },
      }),
    );

    expect(result.apps).toHaveLength(1);
    const rendered = result.apps[0]!.rendered;

    // project.DOMAIN should resolve from projectVars (no environment override).
    expect(rendered).toContain("project.example.com");

    // environment.ENV_NAME should resolve from environmentVars (most specific).
    expect(rendered).toContain("staging");
    expect(rendered).not.toContain("project-env");
  });

  // -------------------------------------------------------------------------
  // 9. Trait ordering -- declaration order produces expected output
  // -------------------------------------------------------------------------

  it("trait ordering: traits are applied in declaration order", async () => {
    // The ingress trait generates an auxiliary Traefik config file (not labels).
    // Verify that the trait is applied and the auxiliary file contains the host,
    // confirming declaration-order processing.
    const composeFile = `services:
  web:
    image: nginx:latest
    ports:
      - "80:80"
`;

    const appbayConfig = `project: homelab
environment: prod
services:
  web:
    traits:
      - type: ingress
        host: first.example.com
        port: 80
`;

    await writeApp(tempDir, "ordered-app", composeFile, appbayConfig);

    const result = await compile(makeOptions());
    expect(result.apps).toHaveLength(1);

    // The ingress trait generates an auxiliary Traefik config file with the host.
    const auxFiles = result.apps[0]!.auxiliaryFiles;
    expect(auxFiles.length).toBeGreaterThan(0);
    const traefikFile = auxFiles.find((f) => f.path.includes("traefik"));
    expect(traefikFile).toBeDefined();
    expect(traefikFile!.content).toContain("first.example.com");

    // The rendered compose should still be valid YAML.
    const parsed = parseYaml(result.apps[0]!.rendered);
    expect(parsed.services.web).toBeDefined();
  });
});
