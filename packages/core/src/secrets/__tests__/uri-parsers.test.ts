/**
 * Unit tests for secret provider URI parsing helpers.
 *
 * Three pure parsing functions, each with its own URI scheme:
 *
 * 1. `extractVarName(uri)` — env:// provider
 *    Strips "env://" prefix to get the environment variable name.
 *    `env://DB_PASSWORD` → `"DB_PASSWORD"`
 *
 * 2. `extractFilePath(uri)` — file:// provider
 *    Strips "file://" prefix, preserving the leading "/" for absolute paths.
 *    `file:///run/secrets/pw` → `"/run/secrets/pw"`
 *
 * 3. `parseSopsUri(uri)` — sops:// provider
 *    Parses `sops://<filePath>#<dotNotationKey>`
 *    Returns { filePath, key }
 *    Throws when '#' is missing, filePath is empty, or key is empty.
 *
 * 4. `toExtractPath(key)` — sops:// jq-style path conversion
 *    Converts dot-notation `"a.b.c"` to jq-style `["a"]["b"]["c"]`
 */

import { describe, it, expect } from "vitest";
import { extractVarName } from "../providers/env.js";
import { extractFilePath } from "../providers/file.js";
import { parseSopsUri, toExtractPath } from "../providers/sops.js";

// ---------------------------------------------------------------------------
// extractVarName (env://)
// ---------------------------------------------------------------------------

describe("extractVarName", () => {
  it("strips 'env://' prefix to return var name", () => {
    expect(extractVarName("env://DB_PASSWORD")).toBe("DB_PASSWORD");
  });

  it("works with single-word var name", () => {
    expect(extractVarName("env://SECRET")).toBe("SECRET");
  });

  it("preserves underscores in var name", () => {
    expect(extractVarName("env://MY_API_KEY")).toBe("MY_API_KEY");
  });

  it("preserves trailing characters verbatim", () => {
    // env:// URIs can technically have any suffix
    expect(extractVarName("env://STRIPE_SECRET_KEY")).toBe("STRIPE_SECRET_KEY");
  });

  it("empty path after env:// returns empty string", () => {
    // Edge: schema-only is technically invalid but we test behavior
    expect(extractVarName("env://")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractFilePath (file://)
// ---------------------------------------------------------------------------

describe("extractFilePath", () => {
  it("strips 'file://' and preserves leading slash for absolute paths", () => {
    // file:// URIs use three slashes: file:// + /absolute/path
    expect(extractFilePath("file:///run/secrets/db_password")).toBe("/run/secrets/db_password");
  });

  it("works with deep absolute path", () => {
    expect(extractFilePath("file:///etc/appbay/secrets/postgres.txt")).toBe(
      "/etc/appbay/secrets/postgres.txt",
    );
  });

  it("strips only 'file://' — remaining path structure is untouched", () => {
    const uri = "file:///home/user/.secret";
    expect(extractFilePath(uri)).toBe("/home/user/.secret");
  });

  it("handles root path file", () => {
    expect(extractFilePath("file:///secret")).toBe("/secret");
  });

  it("preserves relative paths (two slashes — not RFC-compliant but passthrough)", () => {
    // file://relative would strip 7 chars: "file://" → "relative"
    expect(extractFilePath("file://relative/path")).toBe("relative/path");
  });
});

// ---------------------------------------------------------------------------
// parseSopsUri (sops://)
// ---------------------------------------------------------------------------

describe("parseSopsUri", () => {
  // ── Basic parsing ─────────────────────────────────────────────────────────

  it("parses absolute file path with simple key", () => {
    const result = parseSopsUri("sops:///etc/appbay/secrets.yaml#DB_PASSWORD");
    expect(result).toEqual({
      filePath: "/etc/appbay/secrets.yaml",
      key: "DB_PASSWORD",
    });
  });

  it("parses relative file path", () => {
    const result = parseSopsUri("sops://./secrets/prod.yaml#database.password");
    expect(result).toEqual({
      filePath: "./secrets/prod.yaml",
      key: "database.password",
    });
  });

  it("parses dot-notation key", () => {
    const result = parseSopsUri("sops:///secrets.yaml#services.postgres.password");
    expect(result.key).toBe("services.postgres.password");
  });

  it("parses key with no dots", () => {
    const result = parseSopsUri("sops:///file.yaml#SIMPLE_KEY");
    expect(result.key).toBe("SIMPLE_KEY");
  });

  it("filePath is everything between scheme and '#'", () => {
    const result = parseSopsUri("sops:///a/b/c.yaml#k");
    expect(result.filePath).toBe("/a/b/c.yaml");
  });

  // ── Error cases ───────────────────────────────────────────────────────────

  it("throws when '#' fragment is missing", () => {
    expect(() => parseSopsUri("sops:///secrets.yaml")).toThrow("missing '#key' fragment");
  });

  it("throws when file path is empty (just #key)", () => {
    expect(() => parseSopsUri("sops://#mykey")).toThrow("empty file path");
  });

  it("throws when key is empty (file path but no key after #)", () => {
    expect(() => parseSopsUri("sops:///secrets.yaml#")).toThrow("empty key fragment");
  });
});

// ---------------------------------------------------------------------------
// toExtractPath (sops jq-style path converter)
// ---------------------------------------------------------------------------

describe("toExtractPath", () => {
  it("converts single key to jq path", () => {
    expect(toExtractPath("DB_PASSWORD")).toBe('["DB_PASSWORD"]');
  });

  it("converts dot-notation key to jq path", () => {
    expect(toExtractPath("database.password")).toBe('["database"]["password"]');
  });

  it("converts three-level dot-notation", () => {
    expect(toExtractPath("services.postgres.password")).toBe(
      '["services"]["postgres"]["password"]',
    );
  });

  it("converts single-letter key", () => {
    expect(toExtractPath("x")).toBe('["x"]');
  });

  it("handles numeric segments", () => {
    // Unlikely but valid — key parts are treated as strings
    expect(toExtractPath("array.0.value")).toBe('["array"]["0"]["value"]');
  });

  it("preserves special characters within segments", () => {
    expect(toExtractPath("my-key.sub_key")).toBe('["my-key"]["sub_key"]');
  });
});
