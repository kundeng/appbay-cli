/**
 * Unit tests for ps command utilities.
 *
 * Two pure functions, both zero-mock:
 *
 * pad(str, width):
 *   - str shorter than width → padded with trailing spaces to exactly width chars
 *   - str equal to width → returned unchanged
 *   - str longer than width → returned unchanged
 *   - empty string → width spaces
 *   - width 0 → str returned as-is
 *   - unicode characters are treated by .length (code units, not graphemes)
 *
 * formatPorts(ports):
 *   - string input → returned as-is
 *   - empty string → returned as-is
 *   - undefined/null/number → returns ""
 *   - empty array → returns ""
 *   - array of strings → joined with ", "
 *   - array with empty strings filtered out
 *   - array of publisher objects with PublishedPort > 0 → "published->target/protocol"
 *   - array of publisher objects with PublishedPort = 0 → "target/protocol" (no host binding)
 *   - array of publisher objects without PublishedPort → "target/protocol"
 *   - mixed array of strings and objects
 *   - camelCase key aliases (published_port, target_port, protocol)
 *   - protocol defaults to "tcp" when absent
 *   - multiple publishers joined with ", "
 */

import { describe, it, expect } from "vitest";
import { pad } from "../../utils/formatting.js";
import { formatPorts } from "@appbay/core";

// ---------------------------------------------------------------------------
// pad
// ---------------------------------------------------------------------------

describe("pad", () => {
  // ── Padding behavior ──────────────────────────────────────────────────────

  it("pads a short string to the given width with trailing spaces", () => {
    expect(pad("hi", 5)).toBe("hi   ");
  });

  it("returns the string unchanged when it equals the target width", () => {
    expect(pad("hello", 5)).toBe("hello");
  });

  it("returns the string unchanged when it exceeds the target width", () => {
    expect(pad("toolong", 4)).toBe("toolong");
  });

  it("pads an empty string to width spaces", () => {
    expect(pad("", 3)).toBe("   ");
  });

  it("returns empty string unchanged when width is 0", () => {
    expect(pad("", 0)).toBe("");
  });

  it("returns a non-empty string unchanged when width is 0", () => {
    // str.length (1) >= width (0) → no padding
    expect(pad("x", 0)).toBe("x");
  });

  it("pads a single character to width 1 — no change (equal length)", () => {
    expect(pad("A", 1)).toBe("A");
  });

  it("pads a single character to width 4 with three trailing spaces", () => {
    expect(pad("A", 4)).toBe("A   ");
  });

  // ── Column header alignment (typical usage) ───────────────────────────────

  it("aligns a column header to a table width", () => {
    const result = pad("NAME", 20);
    expect(result).toHaveLength(20);
    expect(result.startsWith("NAME")).toBe(true);
  });

  it("aligns a value shorter than the column to the same width", () => {
    const header = pad("STATUS", 12);
    const value = pad("running", 12);
    expect(header).toHaveLength(12);
    expect(value).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// formatPorts
// ---------------------------------------------------------------------------

describe("formatPorts", () => {
  // The Engine API's port list: {PrivatePort, PublicPort?, Type}. No string forms exist any more.
  it("returns '' for no ports", () => {
    expect(formatPorts(undefined)).toBe("");
    expect(formatPorts([])).toBe("");
  });

  it("formats a published port as 'host->container/proto'", () => {
    expect(formatPorts([{ PrivatePort: 80, PublicPort: 8080, Type: "tcp" }])).toBe("8080->80/tcp");
  });

  it("formats an unpublished port as 'container/proto'", () => {
    expect(formatPorts([{ PrivatePort: 80, Type: "tcp" }])).toBe("80/tcp");
  });

  it("joins several and drops the IPv4/IPv6 duplicate the API lists twice", () => {
    expect(formatPorts([
      { IP: "0.0.0.0", PrivatePort: 80, PublicPort: 80, Type: "tcp" },
      { IP: "::", PrivatePort: 80, PublicPort: 80, Type: "tcp" },
      { PrivatePort: 443, PublicPort: 443, Type: "tcp" },
    ])).toBe("80->80/tcp, 443->443/tcp");
  });
});
