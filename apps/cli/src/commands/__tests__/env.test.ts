/**
 * Unit tests for env command utilities.
 *
 * Both `parseEnvFile` and `serializeEnv` are pure string↔Map transforms.
 * No filesystem access, no mocks, no side effects.
 *
 * Coverage:
 *
 * parseEnvFile():
 *   - empty content → empty map
 *   - blank lines are skipped
 *   - comment lines (# prefix) are skipped
 *   - basic KEY=VALUE is parsed
 *   - value may be empty (KEY=)
 *   - value may contain '=' characters (KEY=a=b → value is "a=b")
 *   - lines without '=' are skipped
 *   - lines where '=' is the first character are skipped (eq > 0 guard)
 *   - leading/trailing whitespace on each line is stripped
 *   - multiple variables produce correct map
 *
 * serializeEnv():
 *   - empty map → single newline
 *   - single entry → "KEY=VALUE\n"
 *   - multiple entries → one "KEY=VALUE" per line, trailing newline
 *   - values containing '=' are preserved verbatim
 *   - insertion order is preserved
 *
 * Round-trip:
 *   - parse → serialize → parse gives the same map (stable round-trip)
 */

import { describe, it, expect } from "vitest";
import { parseEnvFile, serializeEnv } from "../env.js";

// ---------------------------------------------------------------------------
// parseEnvFile
// ---------------------------------------------------------------------------

describe("parseEnvFile", () => {
  it("returns an empty map for empty content", () => {
    expect(parseEnvFile("").size).toBe(0);
  });

  it("returns an empty map for content with only newlines", () => {
    expect(parseEnvFile("\n\n\n").size).toBe(0);
  });

  it("skips pure comment lines", () => {
    const result = parseEnvFile("# This is a comment\n# Another comment\n");
    expect(result.size).toBe(0);
  });

  it("skips blank lines between entries", () => {
    const result = parseEnvFile("A=1\n\nB=2\n");
    expect(result.size).toBe(2);
    expect(result.get("A")).toBe("1");
    expect(result.get("B")).toBe("2");
  });

  it("parses a basic KEY=VALUE pair", () => {
    const result = parseEnvFile("FOO=bar\n");
    expect(result.get("FOO")).toBe("bar");
  });

  it("parses a KEY with an empty value (KEY=)", () => {
    const result = parseEnvFile("EMPTY=\n");
    expect(result.get("EMPTY")).toBe("");
  });

  it("preserves '=' characters in values (uses first '=' as delimiter)", () => {
    const result = parseEnvFile("HASH=abc=def=ghi\n");
    expect(result.get("HASH")).toBe("abc=def=ghi");
  });

  it("skips a line with no '=' at all", () => {
    const result = parseEnvFile("NOTAKEY\n");
    expect(result.size).toBe(0);
  });

  it("skips a line where '=' is the first character (empty key)", () => {
    // eq === 0, not > 0 — must be skipped per the eq > 0 guard
    const result = parseEnvFile("=NOKEY\n");
    expect(result.size).toBe(0);
  });

  it("trims whitespace from each raw line before parsing", () => {
    const result = parseEnvFile("  PADDED=value  \n");
    // Trimmed line is "PADDED=value" — key is "PADDED", value is "value"
    // (value trim is NOT applied — only the whole line is trimmed)
    expect(result.get("PADDED")).toBe("value");
  });

  it("trims whitespace from keys (trim applies to the full line)", () => {
    const result = parseEnvFile("  KEY=value\n");
    expect(result.has("KEY")).toBe(true);
    expect(result.has("  KEY")).toBe(false);
  });

  it("parses multiple variables correctly", () => {
    const content = "DB_HOST=localhost\nDB_PORT=5432\nDB_NAME=appbay\n";
    const result = parseEnvFile(content);
    expect(result.size).toBe(3);
    expect(result.get("DB_HOST")).toBe("localhost");
    expect(result.get("DB_PORT")).toBe("5432");
    expect(result.get("DB_NAME")).toBe("appbay");
  });

  it("handles inline comments that follow a value (no special treatment — value includes #)", () => {
    // parseEnvFile does NOT strip inline comments — the # is part of the value
    const result = parseEnvFile("KEY=value # inline comment\n");
    expect(result.get("KEY")).toBe("value # inline comment");
  });

  it("parses content without a trailing newline", () => {
    const result = parseEnvFile("X=1");
    expect(result.get("X")).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// serializeEnv
// ---------------------------------------------------------------------------

describe("serializeEnv", () => {
  it("serializes an empty map to a single newline", () => {
    // join([]) + "\n" = "" + "\n" = "\n"
    expect(serializeEnv(new Map())).toBe("\n");
  });

  it("serializes a single entry", () => {
    const m = new Map([["FOO", "bar"]]);
    expect(serializeEnv(m)).toBe("FOO=bar\n");
  });

  it("serializes multiple entries with one entry per line", () => {
    const m = new Map([
      ["A", "1"],
      ["B", "2"],
      ["C", "3"],
    ]);
    expect(serializeEnv(m)).toBe("A=1\nB=2\nC=3\n");
  });

  it("preserves '=' characters in values", () => {
    const m = new Map([["HASH", "abc=def"]]);
    expect(serializeEnv(m)).toBe("HASH=abc=def\n");
  });

  it("preserves empty values", () => {
    const m = new Map([["EMPTY", ""]]);
    expect(serializeEnv(m)).toBe("EMPTY=\n");
  });

  it("preserves insertion order across multiple entries", () => {
    const m = new Map<string, string>();
    m.set("Z", "last");
    m.set("A", "first");
    m.set("M", "middle");
    const lines = serializeEnv(m).trimEnd().split("\n");
    expect(lines[0]).toBe("Z=last");
    expect(lines[1]).toBe("A=first");
    expect(lines[2]).toBe("M=middle");
  });

  it("always ends with a newline", () => {
    const m = new Map([["X", "y"]]);
    expect(serializeEnv(m).endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: parse → serialize → parse
// ---------------------------------------------------------------------------

describe("parseEnvFile / serializeEnv round-trip", () => {
  it("a simple env content survives parse → serialize → parse", () => {
    const original = "A=1\nB=2\nC=3\n";
    const parsed = parseEnvFile(original);
    const serialized = serializeEnv(parsed);
    const reparsed = parseEnvFile(serialized);

    expect(reparsed.size).toBe(parsed.size);
    for (const [key, value] of parsed) {
      expect(reparsed.get(key)).toBe(value);
    }
  });

  it("comments and blank lines are lost after round-trip (they are not stored)", () => {
    const withComments = "# header\nFOO=bar\n\nBAZ=qux\n";
    const parsed = parseEnvFile(withComments);
    const serialized = serializeEnv(parsed);
    // Comments and blanks are not in the map — they won't appear after serialization
    expect(serialized).not.toContain("#");
    expect(serialized.trim().split("\n").length).toBe(2);
  });

  it("values with '=' survive round-trip intact", () => {
    const original = "HASH=abc=def=ghi\n";
    const parsed = parseEnvFile(original);
    const serialized = serializeEnv(parsed);
    const reparsed = parseEnvFile(serialized);
    expect(reparsed.get("HASH")).toBe("abc=def=ghi");
  });
});
