/**
 * Catalog discovery and the collision rule — RFC-001 §6.2, §6.5, §6.6.
 *
 * `discover.ts` had no tests, which is how "bundled wins on name collision" survived as a
 * one-line condition long enough to become a planned silent regression: moving the UOM stack
 * from `bundled` into `sources/` would have handed `litellm` and `portainer` to upstream's
 * definitions, which disagree with the UOM ones about whether a provider credential is a
 * `required_input` and whether the Docker socket is mounted.
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverCatalog } from "../discover.js";

/** Write a minimal valid catalog.yaml into <home>/var/lib/catalog/<where>/<dir>/. */
async function addEntry(
  home: string,
  where: string,
  dir: string,
  name: string,
  description = "test entry",
): Promise<string> {
  const appDir = join(home, "var", "lib", "catalog", where, dir);
  await mkdir(appDir, { recursive: true });
  await writeFile(
    join(appDir, "catalog.yaml"),
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
  return appDir;
}

async function freshHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "appbay-discover-"));
}

describe("discoverCatalog", () => {
  it("finds bundled entries with no sources present", async () => {
    const home = await freshHome();
    await addEntry(home, "bundled", "alpha", "alpha");

    const { entries, errors, overrides } = await discoverCatalog(home);
    expect(entries.map((e) => e.name)).toEqual(["alpha"]);
    expect(entries[0]!.source).toBe("bundled");
    expect(errors).toEqual([]);
    expect(overrides).toEqual([]);
  });

  it("keys on the name inside catalog.yaml, not the directory name", async () => {
    // §6.6. The directory is `dir-name`, the declared name is `real-name`.
    const home = await freshHome();
    await addEntry(home, "bundled", "dir-name", "real-name");

    const { entries } = await discoverCatalog(home);
    expect(entries.map((e) => e.name)).toEqual(["real-name"]);
    expect(entries[0]!.dir).toContain("dir-name");
  });

  describe("collisions", () => {
    it("lets an added source override bundled, and reports it", async () => {
      // §6.2 — this is the case that was backwards. The UOM stack is the source here.
      const home = await freshHome();
      const bundledDir = await addEntry(home, "bundled", "litellm", "litellm", "upstream's");
      const sourceDir = await addEntry(
        home,
        join("sources", "uom-ai-stack"),
        "litellm",
        "litellm",
        "the UOM one",
      );

      const { entries, errors, overrides } = await discoverCatalog(home);

      const litellm = entries.find((e) => e.name === "litellm");
      expect(litellm?.source).toBe("uom-ai-stack");
      expect(litellm?.entry.description).toBe("the UOM one");
      expect(errors).toEqual([]);

      // Correct, but never silent.
      expect(overrides).toHaveLength(1);
      expect(overrides[0]!.name).toBe("litellm");
      expect(overrides[0]!.source).toBe("uom-ai-stack");
      expect(overrides[0]!.sourceDir).toBe(sourceDir);
      expect(overrides[0]!.shadowedDir).toBe(bundledDir);
    });

    it("does not report an override when a source name does not collide", async () => {
      const home = await freshHome();
      await addEntry(home, "bundled", "open-webui", "open-webui");
      await addEntry(home, join("sources", "uom-ai-stack"), "openwebui", "openwebui");

      const { entries, overrides } = await discoverCatalog(home);
      expect(entries.map((e) => e.name).sort()).toEqual(["open-webui", "openwebui"]);
      expect(overrides).toEqual([]);
    });

    it("errors on a collision between two added sources, naming both directories", async () => {
      // §6.5 — previously decided by readdir() order, i.e. undefined.
      const home = await freshHome();
      const aDir = await addEntry(home, join("sources", "source-a"), "app", "app");
      const bDir = await addEntry(home, join("sources", "source-b"), "app", "app");

      const { entries, errors } = await discoverCatalog(home);

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("source-a");
      expect(errors[0]!.message).toContain("source-b");
      expect(errors[0]!.message).toContain(aDir);
      expect(errors[0]!.message).toContain(bDir);

      // Resolves to neither, rather than to a coin flip.
      expect(entries.find((e) => e.name === "app")).toBeUndefined();
    });

    it("errors when the bundled catalog ships one name twice", async () => {
      const home = await freshHome();
      await addEntry(home, "bundled", "dir-one", "same-name");
      await addEntry(home, "bundled", "dir-two", "same-name");

      const { entries, errors } = await discoverCatalog(home);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("dir-one");
      expect(errors[0]!.message).toContain("dir-two");
      expect(entries.find((e) => e.name === "same-name")).toBeUndefined();
    });

    it("an ambiguous name does not suppress its unaffected neighbours", async () => {
      const home = await freshHome();
      await addEntry(home, join("sources", "source-a"), "clash", "clash");
      await addEntry(home, join("sources", "source-b"), "clash", "clash");
      await addEntry(home, join("sources", "source-a"), "fine", "fine");

      const { entries, errors } = await discoverCatalog(home);
      expect(errors).toHaveLength(1);
      expect(entries.map((e) => e.name)).toEqual(["fine"]);
    });
  });

  describe("near-duplicate names (§6.7)", () => {
    it("flags names that differ only by punctuation or case, without dropping either", async () => {
      const home = await freshHome();
      await addEntry(home, "bundled", "open-webui", "open-webui", "upstream's");
      await addEntry(home, join("sources", "uom-ai-stack"), "openwebui", "openwebui", "the UOM one");

      const { entries, errors, overrides, nearDuplicates } = await discoverCatalog(home);

      // Both still install — this is an ambiguity, not a collision.
      expect(entries.map((e) => e.name).sort()).toEqual(["open-webui", "openwebui"]);
      expect(errors).toEqual([]);
      expect(overrides).toEqual([]);

      expect(nearDuplicates).toHaveLength(1);
      expect(nearDuplicates[0]!.normalized).toBe("openwebui");
      expect(nearDuplicates[0]!.entries.map((e) => e.name).sort()).toEqual([
        "open-webui",
        "openwebui",
      ]);
      expect(nearDuplicates[0]!.entries.map((e) => e.source).sort()).toEqual([
        "bundled",
        "uom-ai-stack",
      ]);
    });

    it("does not flag an exact-name override — that is one event, not two", async () => {
      const home = await freshHome();
      await addEntry(home, "bundled", "litellm", "litellm");
      await addEntry(home, join("sources", "uom-ai-stack"), "litellm", "litellm");

      const { overrides, nearDuplicates } = await discoverCatalog(home);
      expect(overrides).toHaveLength(1);
      expect(nearDuplicates).toEqual([]);
    });

    it("stays quiet on ordinary distinct names", async () => {
      const home = await freshHome();
      await addEntry(home, "bundled", "grafana", "grafana");
      await addEntry(home, "bundled", "prometheus", "prometheus");

      const { nearDuplicates } = await discoverCatalog(home);
      expect(nearDuplicates).toEqual([]);
    });
  });

  it("reports an unparseable catalog.yaml without dropping the rest", async () => {
    const home = await freshHome();
    await addEntry(home, "bundled", "good", "good");
    const badDir = join(home, "var", "lib", "catalog", "bundled", "bad");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "catalog.yaml"), "name: bad\n(this is not valid", "utf-8");

    const { entries, errors } = await discoverCatalog(home);
    expect(entries.map((e) => e.name)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.dir).toBe(badDir);
  });
});
