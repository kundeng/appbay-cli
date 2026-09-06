/**
 * `appbay install <entry> --as <name>`: the vault keys carry the installed name, so two
 * installs of one catalog entry do not share secrets (review 2026-09-06, F5).
 */
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogAddSource, catalogInstall } from "../catalog-service.js";

describe("catalogInstall --as", () => {
  it("names vault refs after the installed app, not the catalog entry", async () => {
    const home = await mkdtemp(join(tmpdir(), "appbay-install-as-"));
    const source = join(home, "catalog-src");
    await mkdir(join(source, "pg"), { recursive: true });
    await writeFile(join(source, "pg", "docker-compose.yml"), "services:\n  db:\n    image: postgres\n");
    await writeFile(join(source, "pg", "appbay.yaml"), "project: default\n");
    await writeFile(join(source, "pg", "catalog.yaml"), [
      "name: pg", "description: d", 'version: "1.0.0"', "category: test", "tags: [test]",
      "readiness: native", "maintainer: test",
      "required_inputs:", "  - name: PW", "    description: db password", "    type: secret", "    auto_generate: true", "",
    ].join("\n"));
    const added = await catalogAddSource(home, "local", source);
    expect(added.success, added.message).toBe(true);
    const r = await catalogInstall({ appbayHome: home, name: "pg", as: "pg-second" });
    expect(r.success, r.message).toBe(true);
    const manifest = await readFile(join(home, "etc", "apps", "pg-second", "appbay.yaml"), "utf-8");
    expect(manifest).toContain("vault://pg-second/PW");
    expect(manifest).not.toContain("vault://pg/PW");
  });
});
