/**
 * Unit tests for validate-utils.ts — formatZodIssue and formatErrorMessage.
 *
 * formatZodIssue({ path, message }):
 *   - Empty path   → message only
 *   - Non-empty path → "a.b.c — message" (dot-joined path + em-dash separator)
 *   - Numeric path segments are joined like strings
 *
 * formatErrorMessage({ file, message, details? }):
 *   - No details (or non-array)       → "basename: message"
 *   - Empty details array             → "basename: message"
 *   - Details with one Zod issue      → "basename: <issue>" (no trailing count)
 *   - Details with multiple Zod issues → "basename: <first> (+N more)"
 *   - Details array but malformed item → "basename: message" (fallback)
 *   - Full file path → uses only the basename (last segment after "/")
 */

import { describe, it, expect } from "vitest";
import { formatZodIssue, formatErrorMessage } from "../validate-utils.js";

// ---------------------------------------------------------------------------
// formatZodIssue
// ---------------------------------------------------------------------------

describe("formatZodIssue", () => {
  it("returns message alone when path is empty", () => {
    expect(formatZodIssue({ path: [], message: "Required" })).toBe("Required");
  });

  it("prepends dot-joined path with em-dash separator", () => {
    expect(formatZodIssue({ path: ["services", "web"], message: "Invalid type" })).toBe(
      "services.web — Invalid type",
    );
  });

  it("joins numeric path segments as strings", () => {
    expect(formatZodIssue({ path: ["traits", 0, "type"], message: "Required" })).toBe(
      "traits.0.type — Required",
    );
  });

  it("handles single-element path", () => {
    expect(formatZodIssue({ path: ["project"], message: "Must be a string" })).toBe(
      "project — Must be a string",
    );
  });
});

// ---------------------------------------------------------------------------
// formatErrorMessage — file basename extraction
// ---------------------------------------------------------------------------

describe("formatErrorMessage — basename extraction", () => {
  it("uses only the filename from a full path", () => {
    expect(
      formatErrorMessage({ file: "/home/user/.appbay/etc/apps/myapp/appbay.yaml", message: "bad yaml" }),
    ).toBe("appbay.yaml: bad yaml");
  });

  it("returns filename unchanged when no path separator present", () => {
    expect(formatErrorMessage({ file: "docker-compose.yml", message: "invalid" })).toBe(
      "docker-compose.yml: invalid",
    );
  });
});

// ---------------------------------------------------------------------------
// formatErrorMessage — no details or empty details
// ---------------------------------------------------------------------------

describe("formatErrorMessage — no details fallback", () => {
  it("uses raw message when details is undefined", () => {
    expect(formatErrorMessage({ file: "/apps/foo/appbay.yaml", message: "parse error" })).toBe(
      "appbay.yaml: parse error",
    );
  });

  it("uses raw message when details is an empty array", () => {
    expect(
      formatErrorMessage({ file: "/apps/foo/appbay.yaml", message: "parse error", details: [] }),
    ).toBe("appbay.yaml: parse error");
  });

  it("uses raw message when details is a non-array value (string)", () => {
    expect(
      formatErrorMessage({ file: "/apps/foo/appbay.yaml", message: "parse error", details: "extra" }),
    ).toBe("appbay.yaml: parse error");
  });
});

// ---------------------------------------------------------------------------
// formatErrorMessage — Zod details formatting
// ---------------------------------------------------------------------------

describe("formatErrorMessage — Zod details", () => {
  it("formats first Zod issue when details has one item", () => {
    const error = {
      file: "/apps/foo/appbay.yaml",
      message: "schema error",
      details: [{ path: ["services", "web"], message: "Required" }],
    };
    expect(formatErrorMessage(error)).toBe("appbay.yaml: services.web — Required");
  });

  it("appends '(+N more)' count when details has multiple issues", () => {
    const error = {
      file: "/apps/foo/appbay.yaml",
      message: "schema error",
      details: [
        { path: ["services"], message: "Required" },
        { path: ["project"], message: "Must be string" },
        { path: ["environment"], message: "Must be string" },
      ],
    };
    expect(formatErrorMessage(error)).toBe("appbay.yaml: services — Required (+2 more)");
  });

  it("does NOT append count when there is exactly one issue", () => {
    const error = {
      file: "/apps/foo/appbay.yaml",
      message: "schema error",
      details: [{ path: [], message: "Top-level error" }],
    };
    const result = formatErrorMessage(error);
    expect(result).not.toContain("more");
    expect(result).toBe("appbay.yaml: Top-level error");
  });

  it("falls back to raw message when first details item lacks path/message", () => {
    const error = {
      file: "/apps/foo/appbay.yaml",
      message: "fallback message",
      details: [{ code: "invalid_type" }],
    };
    expect(formatErrorMessage(error)).toBe("appbay.yaml: fallback message");
  });
});
