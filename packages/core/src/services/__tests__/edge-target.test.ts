/**
 * The edge container the deploy path talks to must be the one the compiler names.
 *
 * Review 2026-09-05 F0: the system apps declare `namespace: system`, so the compiler renders
 * the edge as `appbay.system.caddy.caddy`, while the deploy path still exec'd into the
 * literal `appbay.caddy.caddy`. Every ingress app on a caddy host reported its routes as
 * not installed. This test compiles the real system app and pins two things: the rendered
 * name follows identity, and the deploy path carries no literal edge name at all.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compile } from "../../compiler/compile.js";
import { SYSTEM_APPS } from "../../system-apps.js";
import { APP_LABEL, containerName } from "../../compiler/identity.js";

describe("the edge the deploy path targets is the edge the compiler names", () => {
  it("renders caddy under the system namespace, labelled for lookup", async () => {
    const home = mkdtempSync(join(tmpdir(), "appbay-edge-target-"));
    try {
      const appsDir = join(home, "etc", "apps");
      const caddy = SYSTEM_APPS.find((a) => a.name === "caddy");
      expect(caddy).toBeDefined();
      const dir = join(appsDir, "caddy");
      for (const [rel, content] of Object.entries(caddy!.files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), content);
      }
      const result = await compile({
        appsDir, rendersDir: join(home, "renders"), stateDir: join(home, "state"),
        apps: ["caddy"], projectVars: { DOMAIN: "example.org" },
      });
      expect(result.errors).toEqual([]);
      const rendered = result.apps[0]!.rendered;
      expect(rendered).toContain(`container_name: ${containerName("system", "caddy", "caddy")}`);
      expect(rendered).toContain(`${APP_LABEL}: caddy`);
      expect(containerName("system", "caddy", "caddy")).toBe("appbay.system.caddy.caddy");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the deploy path, the identity service and setup carry no literal edge name", () => {
    const root = join(__dirname, "..", "..", "..", "..", "..");
    for (const rel of [
      "packages/core/src/services/deploy-service.ts",
      "packages/core/src/services/edge-identity-service.ts",
      "apps/cli/src/commands/setup.ts",
    ]) {
      const src = readFileSync(join(root, rel), "utf-8");
      expect(src, rel).not.toMatch(/"appbay\.caddy(\.caddy)?"/);
      expect(src, rel).toContain("findContainerByLabel");
    }
  });
});
