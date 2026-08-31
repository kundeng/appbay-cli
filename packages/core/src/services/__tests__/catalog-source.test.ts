/**
 * `catalogAddSource` with a LOCAL PATH — RFC-001 §6.1.
 *
 * The function could only `git clone`, so the one caller that matters could not use it: the
 * consuming project's converge passes a directory (`provision-appbay.yml`:
 * `appbay init --catalog /app/llm-stack-catalog`). Registering that as a source is what stops
 * `--catalog` from overwriting `bundled`, so a clone-only implementation left §6.1
 * unimplementable and the operator's catalog occupying the shipped catalog's slot.
 */

import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogAddSource, catalogListSources } from "../catalog-service.js";
import { discoverCatalog } from "../../catalog/discover.js";

async function writeEntry(dir: string, name: string, description: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(
    join(dir, name, "catalog.yaml"),
    [
      `name: ${name}`,
      `description: ${description}`,
      `version: "1.0.0"`,
      `category: test`,
      `tags: [test]`,
      `readiness: native`,
      `maintainer: test`,
      `required_inputs: []`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

describe("catalogAddSource with a local directory", () => {
  it("registers a local path as a source and counts its entries", async () => {
    const home = await mkdtemp(join(tmpdir(), "appbay-src-"));
    const catalog = await mkdtemp(join(tmpdir(), "appbay-uom-"));
    await writeEntry(catalog, "litellm", "the operator's litellm");
    await writeEntry(catalog, "sysinfo", "the operator's sysinfo");

    const result = await catalogAddSource(home, "local", catalog);

    expect(result.success).toBe(true);
    expect(result.entryCount).toBe(2);

    const listed = await catalogListSources(home);
    expect(listed.find((s) => s.name === "local")?.url).toBe(catalog);
  });

  it("leaves bundled untouched — the whole point of §6.1", async () => {
    const home = await mkdtemp(join(tmpdir(), "appbay-src-"));
    const bundled = join(home, "var", "lib", "catalog", "bundled");
    await writeEntry(bundled, "litellm", "the SHIPPED litellm");
    await writeEntry(bundled, "grafana", "shipped, no collision");

    const catalog = await mkdtemp(join(tmpdir(), "appbay-uom-"));
    await writeEntry(catalog, "litellm", "the operator's litellm");

    await catalogAddSource(home, "local", catalog);

    // bundled still holds exactly what it held.
    expect((await readdir(bundled)).sort()).toEqual(["grafana", "litellm"]);
    expect(await readFile(join(bundled, "litellm", "catalog.yaml"), "utf-8")).toContain(
      "the SHIPPED litellm",
    );

    // …and the operator's definition is the one that resolves, reported as an override.
    const { entries, overrides } = await discoverCatalog(home);
    const litellm = entries.find((e) => e.name === "litellm");
    expect(litellm?.source).toBe("local");
    expect(litellm?.entry.description).toBe("the operator's litellm");
    expect(overrides.map((o) => o.name)).toEqual(["litellm"]);

    // The non-colliding shipped app is still there — an override is not a replacement.
    expect(entries.find((e) => e.name === "grafana")?.source).toBe("bundled");
  });

  it("refuses to re-register a name, so a re-run of init does not accumulate copies", async () => {
    const home = await mkdtemp(join(tmpdir(), "appbay-src-"));
    const catalog = await mkdtemp(join(tmpdir(), "appbay-uom-"));
    await writeEntry(catalog, "mcp", "operator mcp");

    expect((await catalogAddSource(home, "local", catalog)).success).toBe(true);

    const second = await catalogAddSource(home, "local", catalog);
    expect(second.success).toBe(false);
    expect(second.message).toContain("already exists");
  });

  it("still treats a non-directory as a URL and fails cleanly when it is not clonable", async () => {
    const home = await mkdtemp(join(tmpdir(), "appbay-src-"));
    const result = await catalogAddSource(home, "nope", "/definitely/not/a/directory");
    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to clone");
  });

  it("follows a symlinked local catalog, so an out-of-band edit stays live", async () => {
    const home = await mkdtemp(join(tmpdir(), "appbay-src-"));
    const catalog = await mkdtemp(join(tmpdir(), "appbay-uom-"));
    await writeEntry(catalog, "openwebui", "before");

    await catalogAddSource(home, "local", catalog);
    await writeEntry(catalog, "openwebui", "after");

    const { entries } = await discoverCatalog(home);
    expect(entries.find((e) => e.name === "openwebui")?.entry.description).toBe("after");
  });
});
