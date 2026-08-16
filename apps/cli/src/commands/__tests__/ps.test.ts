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
import { formatPorts } from "../ps.js";

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
  // ── String input ──────────────────────────────────────────────────────────

  it("returns a string port as-is", () => {
    expect(formatPorts("0.0.0.0:80->80/tcp")).toBe("0.0.0.0:80->80/tcp");
  });

  it("returns an empty string as-is", () => {
    expect(formatPorts("")).toBe("");
  });

  // ── Non-array / non-string input → empty string ───────────────────────────

  it("returns '' for undefined", () => {
    expect(formatPorts(undefined)).toBe("");
  });

  it("returns '' for null", () => {
    expect(formatPorts(null)).toBe("");
  });

  it("returns '' for a number", () => {
    expect(formatPorts(42)).toBe("");
  });

  it("returns '' for a plain object (not an array)", () => {
    expect(formatPorts({ port: 80 })).toBe("");
  });

  // ── Empty array ───────────────────────────────────────────────────────────

  it("returns '' for an empty array", () => {
    expect(formatPorts([])).toBe("");
  });

  // ── Array of strings ──────────────────────────────────────────────────────

  it("joins an array of string ports with ', '", () => {
    expect(formatPorts(["80/tcp", "443/tcp"])).toBe("80/tcp, 443/tcp");
  });

  it("filters out empty string entries from a string array", () => {
    expect(formatPorts(["80/tcp", "", "443/tcp"])).toBe("80/tcp, 443/tcp");
  });

  it("returns a single string entry without a trailing comma", () => {
    expect(formatPorts(["8080/tcp"])).toBe("8080/tcp");
  });

  // ── Array of publisher objects (PascalCase keys) ──────────────────────────

  it("formats a bound port (PublishedPort > 0) as 'published->target/protocol'", () => {
    const publishers = [
      { PublishedPort: 8080, TargetPort: 80, Protocol: "tcp" },
    ];
    expect(formatPorts(publishers)).toBe("8080->80/tcp");
  });

  it("formats an unbound port (PublishedPort = 0) as 'target/protocol' without host", () => {
    const publishers = [
      { PublishedPort: 0, TargetPort: 80, Protocol: "tcp" },
    ];
    expect(formatPorts(publishers)).toBe("80/tcp");
  });

  it("formats a publisher with no PublishedPort key as 'target/protocol'", () => {
    const publishers = [{ TargetPort: 443, Protocol: "tcp" }];
    expect(formatPorts(publishers)).toBe("443/tcp");
  });

  it("defaults protocol to 'tcp' when Protocol key is absent", () => {
    const publishers = [{ PublishedPort: 3000, TargetPort: 3000 }];
    expect(formatPorts(publishers)).toBe("3000->3000/tcp");
  });

  it("joins multiple publisher objects with ', '", () => {
    const publishers = [
      { PublishedPort: 80, TargetPort: 80, Protocol: "tcp" },
      { PublishedPort: 443, TargetPort: 443, Protocol: "tcp" },
    ];
    expect(formatPorts(publishers)).toBe("80->80/tcp, 443->443/tcp");
  });

  // ── snake_case key aliases (newer docker compose versions) ────────────────

  it("accepts snake_case aliases (published_port / target_port / protocol)", () => {
    const publishers = [
      { published_port: 9090, target_port: 9090, protocol: "tcp" },
    ];
    expect(formatPorts(publishers)).toBe("9090->9090/tcp");
  });

  it("snake_case with published_port = 0 shows target only", () => {
    const publishers = [{ published_port: 0, target_port: 3000, protocol: "tcp" }];
    expect(formatPorts(publishers)).toBe("3000/tcp");
  });

  // ── UDP protocol ──────────────────────────────────────────────────────────

  it("preserves udp protocol", () => {
    const publishers = [
      { PublishedPort: 5353, TargetPort: 5353, Protocol: "udp" },
    ];
    expect(formatPorts(publishers)).toBe("5353->5353/udp");
  });

  // ── Mixed array ───────────────────────────────────────────────────────────

  it("handles a mixed array of strings and objects", () => {
    const ports = [
      "80/tcp",
      { PublishedPort: 443, TargetPort: 443, Protocol: "tcp" },
    ];
    expect(formatPorts(ports)).toBe("80/tcp, 443->443/tcp");
  });
});
