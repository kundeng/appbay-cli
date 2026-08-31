/**
 * App config read/write — `appbay config <app> [key] [value]`.
 *
 * ⚠️ 229 lines, 11 exports, every one of them reachable from the CLI, and no tests. The
 * dotted-key path is raw operator input handed straight to `setByPath`, which creates
 * intermediate objects as it walks — so the interesting cases here are the keys nobody
 * intends to type, not the ones they do.
 */

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getByPath,
  setByPath,
  coerceValue,
  getAppConfig,
  getAppConfigValue,
  setAppConfigValue,
} from "../config-service.js";

describe("getByPath", () => {
  const doc = { upstream: { source: "./compose.yml" }, port: 8080, nil: null };

  it("resolves a dotted path", () => {
    expect(getByPath(doc, "upstream.source")).toBe("./compose.yml");
    expect(getByPath(doc, "port")).toBe(8080);
  });

  it("returns undefined rather than throwing on a missing or non-object segment", () => {
    expect(getByPath(doc, "upstream.missing")).toBeUndefined();
    expect(getByPath(doc, "port.deeper")).toBeUndefined();
    expect(getByPath(doc, "nil.deeper")).toBeUndefined();
  });
});

describe("setByPath", () => {
  it("creates intermediate objects", () => {
    const doc: Record<string, unknown> = {};
    setByPath(doc, "traits.ingress.host", "example.org");
    expect(doc).toEqual({ traits: { ingress: { host: "example.org" } } });
  });

  it("replaces a non-object segment rather than walking into it", () => {
    const doc: Record<string, unknown> = { a: 5 };
    setByPath(doc, "a.b", 1);
    expect(doc).toEqual({ a: { b: 1 } });
  });

  // 🚨 The defect this file was written for. `setByPath` walked a dotted path creating
  // objects, and the path is raw CLI input, so `__proto__` — present on every object and
  // itself an object — was traversed INTO. `appbay config myapp __proto__.polluted yes` made
  // `({}).polluted === "yes"` for every object in the process. Measured before the fix.
  describe("prototype pollution", () => {
    it("refuses __proto__ as a path segment", () => {
      const doc: Record<string, unknown> = {};
      expect(() => setByPath(doc, "__proto__.polluted", "yes")).toThrow(/__proto__/);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("refuses constructor and prototype too", () => {
      const doc: Record<string, unknown> = {};
      expect(() => setByPath(doc, "constructor.prototype.pwned", 1)).toThrow(/constructor/);
      expect(() => setByPath(doc, "a.prototype.b", 1)).toThrow(/prototype/);
      expect(({} as Record<string, unknown>).pwned).toBeUndefined();
    });

    it("refuses them on read as well", () => {
      expect(() => getByPath({}, "__proto__.toString")).toThrow(/__proto__/);
    });

    it("still allows a key that merely CONTAINS a reserved word", () => {
      const doc: Record<string, unknown> = {};
      setByPath(doc, "my__proto__key", 1);
      setByPath(doc, "constructors", 2);
      expect(doc).toEqual({ my__proto__key: 1, constructors: 2 });
    });
  });
});

describe("coerceValue", () => {
  it("coerces the JSON scalars", () => {
    expect(coerceValue("true")).toBe(true);
    expect(coerceValue("false")).toBe(false);
    expect(coerceValue("null")).toBeNull();
    expect(coerceValue("8080")).toBe(8080);
    expect(coerceValue("3.14")).toBe(3.14);
  });

  it("leaves non-numeric strings alone, including empty and whitespace", () => {
    expect(coerceValue("example.org")).toBe("example.org");
    expect(coerceValue("2.27.0")).toBe("2.27.0"); // three parts — not a number
    expect(coerceValue("")).toBe("");
    expect(coerceValue(" ")).toBe(" ");
  });

  // ⚠️ These are LOSSY and are pinned deliberately rather than fixed: coercion is the
  // documented intent, and changing it would alter every existing config write. Worth knowing
  // before typing a version or an id: `1.0` does not survive as a string.
  it("is lossy on values that look numeric but are not meant as numbers", () => {
    expect(coerceValue("1.0")).toBe(1); // a version string becomes the number 1
    expect(coerceValue("007")).toBe(7); // leading zeros are gone
    expect(coerceValue("0x10")).toBe(16); // hex is parsed
    expect(coerceValue("+1")).toBe(1);
    expect(coerceValue("1e999")).toBe(Infinity); // serialises to YAML `.inf`
  });
});

describe("appbay.yaml read/write", () => {
  async function appWith(yaml: string): Promise<{ home: string; app: string }> {
    const home = await mkdtemp(join(tmpdir(), "appbay-config-"));
    const app = "myapp";
    await mkdir(join(home, "etc", "apps", app), { recursive: true });
    await writeFile(join(home, "etc", "apps", app, "appbay.yaml"), yaml, "utf-8");
    return { home, app };
  }

  it("reads a config and a single key", async () => {
    const { home, app } = await appWith("namespace: uom.sim\nupstream:\n  source: ./c.yml\n");
    expect((await getAppConfig(home, app))?.config).toMatchObject({ namespace: "uom.sim" });
    expect(await getAppConfigValue(home, app, "upstream.source")).toEqual({
      found: true,
      value: "./c.yml",
    });
  });

  it("reports a missing key as not found rather than as undefined-valued", async () => {
    const { home, app } = await appWith("namespace: uom.sim\n");
    expect((await getAppConfigValue(home, app, "nope.deeper")).found).toBe(false);
  });

  it("returns null for an app that has no appbay.yaml", async () => {
    const home = await mkdtemp(join(tmpdir(), "appbay-config-"));
    await mkdir(join(home, "etc", "apps", "bare"), { recursive: true });
    expect(await getAppConfig(home, "bare")).toBeNull();
  });

  it("writes a value back, coerced, preserving the rest of the document", async () => {
    const { home, app } = await appWith("namespace: uom.sim\ncollection:\n  - media\n");
    await setAppConfigValue(home, app, "operator", "local");
    await setAppConfigValue(home, app, "shared_network", "8080");

    const written = await readFile(join(home, "etc", "apps", app, "appbay.yaml"), "utf-8");
    expect(written).toContain("namespace: uom.sim");
    expect(written).toContain("- media");
    expect(written).toContain("operator: local");
    expect(written).toContain("shared_network: 8080"); // coerced to a number, unquoted
  });

  it("refuses to write through a prototype-reaching key", async () => {
    const { home, app } = await appWith("namespace: uom.sim\n");
    await expect(setAppConfigValue(home, app, "__proto__.x", "1")).rejects.toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
