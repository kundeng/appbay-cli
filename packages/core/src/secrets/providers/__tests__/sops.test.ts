/**
 * `sops://` URI parsing and extract-path construction.
 *
 * ⭐ THE PATH FUNCTION IS THE ONE THAT MATTERS. `toExtractPath` builds sops's `--extract`
 * expression by CONCATENATION, so a key carrying a quote or bracket rewrites the path's shape
 * instead of being quoted into it. Measured before the fix:
 *
 *     toExtractPath('a"]["b')  ->  ["a"]["b"]
 *     toExtractPath('a.b')     ->  ["a"]["b"]      ← identical
 *
 * Two different URIs selecting the same secret, silently. Not shell injection — `execFile`
 * takes an argv array — but injection into sops's own extract expression, and worth refusing
 * for the same reason.
 *
 * ⚠️ Reachability, stated honestly: a MANIFEST cannot carry a `sops://` ref since RFC-001 §3.2
 * narrowed the enum to `vault://`. The provider is still registered in three places — the
 * deploy resolver, the CLI's secrets command, and the web secrets router — so the surface is
 * narrow but live.
 */

import { describe, expect, it } from "vitest";
import { parseSopsUri, toExtractPath } from "../sops.js";

describe("parseSopsUri", () => {
  it("splits an absolute path from its key", () => {
    expect(parseSopsUri("sops:///etc/appbay/secrets.yaml#database.password")).toEqual({
      filePath: "/etc/appbay/secrets.yaml",
      key: "database.password",
    });
  });

  it("handles a relative path", () => {
    expect(parseSopsUri("sops://./secrets/prod.yaml#DB_PASSWORD")).toEqual({
      filePath: "./secrets/prod.yaml",
      key: "DB_PASSWORD",
    });
  });

  it("splits on the FIRST '#', so a key may not silently swallow one", () => {
    expect(parseSopsUri("sops://f.yaml#a#b").key).toBe("a#b");
  });

  it("refuses a URI with no key fragment", () => {
    // Without this the whole file would be decrypted and something arbitrary returned.
    expect(() => parseSopsUri("sops:///s.yaml")).toThrow(/missing '#key' fragment/);
  });

  it("refuses an empty path or an empty key", () => {
    expect(() => parseSopsUri("sops://#key")).toThrow(/empty file path/);
    expect(() => parseSopsUri("sops:///s.yaml#")).toThrow(/empty key fragment/);
  });
});

describe("toExtractPath", () => {
  it("maps dot notation to a jq path", () => {
    expect(toExtractPath("database.password")).toBe('["database"]["password"]');
  });

  it("wraps a flat key", () => {
    expect(toExtractPath("DB_PASSWORD")).toBe('["DB_PASSWORD"]');
  });

  it("keeps characters that are harmless in a key", () => {
    expect(toExtractPath("app-1_prod")).toBe('["app-1_prod"]');
  });

  it("🚨 refuses a key whose quotes would rewrite the path", () => {
    // The aliasing case: this used to produce exactly the same path as "a.b".
    expect(() => toExtractPath('a"]["b')).toThrow(/would change the extract path/);
  });

  it("🚨 refuses brackets too, not just quotes", () => {
    expect(() => toExtractPath("a[0]")).toThrow(/would change the extract path/);
    expect(() => toExtractPath('x"')).toThrow(/would change the extract path/);
  });

  it("names the offending character, so the message is actionable", () => {
    // "invalid key" alone sends the operator hunting through a file they cannot read.
    expect(() => toExtractPath('a"b')).toThrow(/the character "\\""/);
  });

  it("refuses an empty segment rather than addressing a key nobody wrote", () => {
    // `a..b` would emit `[""]` in the middle of the path.
    expect(() => toExtractPath("a..b")).toThrow(/empty path segment/);
    expect(() => toExtractPath(".a")).toThrow(/empty path segment/);
    expect(() => toExtractPath("a.")).toThrow(/empty path segment/);
  });

  it("🚨 the two aliasing inputs no longer agree — one is refused", () => {
    // The property that was broken: distinct URIs must not resolve to one secret.
    expect(toExtractPath("a.b")).toBe('["a"]["b"]');
    expect(() => toExtractPath('a"]["b')).toThrow();
  });
});
