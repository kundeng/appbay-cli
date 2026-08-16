/**
 * Unit tests for config command utilities.
 *
 * Three pure functions, all zero-mock:
 *
 * getByPath(obj, key):
 *   - Single-level key
 *   - Nested dot-separated path (2 and 3 levels deep)
 *   - Missing top-level key → undefined
 *   - Missing intermediate key → undefined
 *   - Non-object at an intermediate segment → undefined
 *   - null at an intermediate segment → undefined
 *   - Key that resolves to a falsy value (0, false, "") still returns that value
 *
 * setByPath(obj, key, value):
 *   - Single-level key is created
 *   - Nested path creates intermediate objects
 *   - Nested path overwrites an existing value
 *   - Overwrites a non-object intermediate with an object (upsert)
 *   - Values of any type are accepted (string, number, boolean, null, object)
 *   - Mutates the original object in-place
 *
 * coerceValue(raw):
 *   - "true"  → true  (boolean)
 *   - "false" → false (boolean)
 *   - "null"  → null
 *   - "0"     → 0    (number)
 *   - "42"    → 42   (number)
 *   - "-1.5"  → -1.5 (number)
 *   - ""      → ""   (empty string, not coerced to 0)
 *   - "  "    → "  " (whitespace string, not coerced to 0)
 *   - "hello" → "hello" (plain string)
 *   - "NaN"   → "NaN"   (Number("NaN") is NaN — not coerced)
 *
 * getByPath / setByPath symmetry:
 *   - A value written with setByPath can be read back with getByPath
 */

import { describe, it, expect } from "vitest";
import { getByPath, setByPath, coerceValue } from "../config.js";

// ---------------------------------------------------------------------------
// getByPath
// ---------------------------------------------------------------------------

describe("getByPath", () => {
  // ── Single-level ──────────────────────────────────────────────────────────

  it("returns the value for a top-level key", () => {
    expect(getByPath({ a: 1 }, "a")).toBe(1);
  });

  it("returns undefined for a missing top-level key", () => {
    expect(getByPath({}, "missing")).toBeUndefined();
  });

  // ── Nested paths ──────────────────────────────────────────────────────────

  it("returns a value two levels deep", () => {
    const obj = { outer: { inner: "hello" } };
    expect(getByPath(obj, "outer.inner")).toBe("hello");
  });

  it("returns a value three levels deep", () => {
    const obj = { a: { b: { c: 42 } } };
    expect(getByPath(obj, "a.b.c")).toBe(42);
  });

  it("returns undefined when an intermediate key is missing", () => {
    const obj = { a: {} };
    expect(getByPath(obj as Record<string, unknown>, "a.missing.c")).toBeUndefined();
  });

  // ── Edge cases at intermediate segments ───────────────────────────────────

  it("returns undefined when an intermediate segment is null", () => {
    const obj = { a: null };
    expect(getByPath(obj as Record<string, unknown>, "a.b")).toBeUndefined();
  });

  it("returns undefined when an intermediate segment is a primitive (number)", () => {
    const obj = { a: 42 };
    expect(getByPath(obj as Record<string, unknown>, "a.b")).toBeUndefined();
  });

  it("returns undefined when an intermediate segment is a primitive (string)", () => {
    const obj = { a: "string" };
    expect(getByPath(obj as Record<string, unknown>, "a.length")).toBeUndefined();
  });

  // ── Falsy values must not be confused with missing values ─────────────────

  it("returns 0 (falsy) for a key that holds 0", () => {
    expect(getByPath({ n: 0 }, "n")).toBe(0);
  });

  it("returns false (falsy) for a key that holds false", () => {
    expect(getByPath({ flag: false }, "flag")).toBe(false);
  });

  it("returns empty string for a key that holds empty string", () => {
    expect(getByPath({ s: "" }, "s")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// setByPath
// ---------------------------------------------------------------------------

describe("setByPath", () => {
  // ── Single-level ──────────────────────────────────────────────────────────

  it("creates a top-level key on an empty object", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "foo", "bar");
    expect(obj.foo).toBe("bar");
  });

  it("overwrites an existing top-level key", () => {
    const obj: Record<string, unknown> = { foo: "old" };
    setByPath(obj, "foo", "new");
    expect(obj.foo).toBe("new");
  });

  // ── Nested creation ───────────────────────────────────────────────────────

  it("creates intermediate objects for a two-level path", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "a.b", 99);
    expect((obj.a as Record<string, unknown>).b).toBe(99);
  });

  it("creates intermediate objects for a three-level path", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "x.y.z", true);
    const x = obj.x as Record<string, unknown>;
    const y = x.y as Record<string, unknown>;
    expect(y.z).toBe(true);
  });

  it("preserves sibling keys when setting a nested key", () => {
    const obj: Record<string, unknown> = { a: { existing: 1 } };
    setByPath(obj, "a.new", 2);
    const a = obj.a as Record<string, unknown>;
    expect(a.existing).toBe(1);
    expect(a.new).toBe(2);
  });

  // ── Overwrite non-object intermediate ─────────────────────────────────────

  it("replaces a non-object intermediate with an object", () => {
    // 'a' is a number — setByPath should overwrite it with an object
    const obj: Record<string, unknown> = { a: 42 };
    setByPath(obj, "a.b", "x");
    expect(typeof obj.a).toBe("object");
    expect((obj.a as Record<string, unknown>).b).toBe("x");
  });

  it("replaces a null intermediate with an object", () => {
    const obj: Record<string, unknown> = { a: null };
    setByPath(obj, "a.b", "y");
    expect(typeof obj.a).toBe("object");
  });

  // ── Value types ───────────────────────────────────────────────────────────

  it("stores null at a path", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "k", null);
    expect(obj.k).toBeNull();
  });

  it("stores a boolean at a path", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "flag", false);
    expect(obj.flag).toBe(false);
  });

  it("stores an object at a path", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "nested", { inner: 1 });
    expect(obj.nested).toEqual({ inner: 1 });
  });

  it("mutates the original object (no copy)", () => {
    const obj: Record<string, unknown> = {};
    const ref = obj;
    setByPath(obj, "x", 1);
    expect(ref).toBe(obj);
    expect(ref.x).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// coerceValue
// ---------------------------------------------------------------------------

describe("coerceValue", () => {
  // ── Boolean coercion ──────────────────────────────────────────────────────

  it('coerces "true" to boolean true', () => {
    expect(coerceValue("true")).toBe(true);
  });

  it('coerces "false" to boolean false', () => {
    expect(coerceValue("false")).toBe(false);
  });

  // ── Null coercion ─────────────────────────────────────────────────────────

  it('coerces "null" to null', () => {
    expect(coerceValue("null")).toBeNull();
  });

  // ── Numeric coercion ─────────────────────────────────────────────────────

  it('coerces "0" to number 0', () => {
    expect(coerceValue("0")).toBe(0);
  });

  it('coerces "42" to number 42', () => {
    expect(coerceValue("42")).toBe(42);
  });

  it('coerces "-1.5" to number -1.5', () => {
    expect(coerceValue("-1.5")).toBe(-1.5);
  });

  it('coerces "1e3" to number 1000', () => {
    expect(coerceValue("1e3")).toBe(1000);
  });

  // ── Empty / whitespace string stays as string ─────────────────────────────

  it("returns empty string as-is (not coerced to 0)", () => {
    // raw.trim() === "" guard prevents Number("") = 0 from being returned
    expect(coerceValue("")).toBe("");
  });

  it("returns whitespace-only string as-is (not coerced to 0)", () => {
    // Number("  ") is 0, but raw.trim() === "" prevents coercion
    expect(coerceValue("  ")).toBe("  ");
  });

  // ── NaN string stays as string ────────────────────────────────────────────

  it('returns "NaN" as-is (Number("NaN") is NaN, excluded by !isNaN check)', () => {
    expect(coerceValue("NaN")).toBe("NaN");
  });

  // ── Plain strings stay as strings ─────────────────────────────────────────

  it("returns a plain string unchanged", () => {
    expect(coerceValue("hello")).toBe("hello");
  });

  it("returns a URL-like string unchanged", () => {
    expect(coerceValue("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("returns a path string unchanged", () => {
    expect(coerceValue("/etc/appbay/config")).toBe("/etc/appbay/config");
  });

  // ── Type of the return values ─────────────────────────────────────────────

  it('coerced "true" is actually typeof boolean', () => {
    expect(typeof coerceValue("true")).toBe("boolean");
  });

  it('coerced "42" is actually typeof number', () => {
    expect(typeof coerceValue("42")).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// getByPath / setByPath round-trip
// ---------------------------------------------------------------------------

describe("getByPath + setByPath symmetry", () => {
  it("a value written with setByPath is readable by getByPath", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "db.host", "localhost");
    expect(getByPath(obj, "db.host")).toBe("localhost");
  });

  it("deep nested set+get round-trip", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "a.b.c.d", 999);
    expect(getByPath(obj, "a.b.c.d")).toBe(999);
  });

  it("overwriting via setByPath is reflected in getByPath", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "key", "first");
    setByPath(obj, "key", "second");
    expect(getByPath(obj, "key")).toBe("second");
  });
});
