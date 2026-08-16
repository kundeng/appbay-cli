/**
 * Unit tests for validate command utilities.
 *
 * `formatZodIssue` is a pure formatting function that turns a Zod-style
 * issue object into a human-readable string. Zero mocks needed.
 *
 * Coverage:
 *   - path is empty array → just the message
 *   - path has one string segment → "segment — message"
 *   - path has multiple segments → joined with "." → "a.b.c — message"
 *   - path contains numeric indices → "services.0.image — message"
 *   - message is empty string → still returns path if present, or ""
 *   - path segments with special characters are joined as-is
 */

import { describe, it, expect } from "vitest";
import { formatZodIssue } from "../validate.js";

describe("formatZodIssue", () => {
  // ── No path (root-level issues) ───────────────────────────────────────────

  it("returns just the message when path is empty", () => {
    expect(formatZodIssue({ path: [], message: "Required" })).toBe("Required");
  });

  it("returns just the message when path is empty and message has special chars", () => {
    expect(
      formatZodIssue({ path: [], message: "Expected string, received number" }),
    ).toBe("Expected string, received number");
  });

  // ── Single-segment path ───────────────────────────────────────────────────

  it("formats a single string path segment with the separator", () => {
    expect(formatZodIssue({ path: ["name"], message: "Required" })).toBe(
      "name — Required",
    );
  });

  it("formats a single numeric path segment (array index)", () => {
    expect(formatZodIssue({ path: [0], message: "Invalid type" })).toBe(
      "0 — Invalid type",
    );
  });

  // ── Multi-segment path ────────────────────────────────────────────────────

  it("joins multiple string segments with '.' then appends separator and message", () => {
    expect(
      formatZodIssue({ path: ["services", "web"], message: "Missing" }),
    ).toBe("services.web — Missing");
  });

  it("joins string and numeric segments (typical Zod nested array path)", () => {
    expect(
      formatZodIssue({ path: ["services", 0, "image"], message: "Required" }),
    ).toBe("services.0.image — Required");
  });

  it("joins three string segments correctly", () => {
    expect(
      formatZodIssue({
        path: ["upstream", "source", "url"],
        message: "Invalid URL",
      }),
    ).toBe("upstream.source.url — Invalid URL");
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("returns empty string when both path and message are empty", () => {
    // path.join(".") = "", path is falsy → return message = ""
    expect(formatZodIssue({ path: [], message: "" })).toBe("");
  });

  it("path present with empty message still includes the separator", () => {
    // Format: "key — " (em dash with spaces, message is empty string)
    expect(formatZodIssue({ path: ["key"], message: "" })).toBe("key — ");
  });

  it("the separator is an em-dash (—), not a hyphen (-)", () => {
    const result = formatZodIssue({ path: ["field"], message: "bad" });
    expect(result).toContain("—");
    expect(result).not.toBe("field - bad");
  });
});
