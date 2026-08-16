/**
 * Unit tests for the extractVersion helper in runtime/facts.ts.
 *
 * `extractVersion(raw, pattern)` — pure string extraction:
 *   - Returns "unknown" when raw is null
 *   - Returns "unknown" when the pattern does not match
 *   - Returns capture group [1] when the pattern matches
 *
 * This function is used to parse Docker version strings like
 * "Docker version 24.0.7, build afdd53b4e3" down to just "24.0.7".
 *
 * Coverage:
 *   - null input → "unknown"
 *   - empty string input → "unknown"
 *   - pattern with no match → "unknown"
 *   - Docker version string → semver portion
 *   - Compose version string → semver without 'v' prefix
 *   - Pattern can match anywhere in the string (not anchored)
 *   - Only capture group [1] is returned, not the full match
 */

import { describe, it, expect } from "vitest";
import { extractVersion } from "../facts.js";

const DOCKER_PATTERN = /Docker version ([0-9]+\.[0-9]+\.[0-9]+)/;
const SEMVER_PATTERN = /([0-9]+\.[0-9]+\.[0-9]+)/;

describe("extractVersion", () => {
  // ── Null / empty inputs ───────────────────────────────────────────────────

  it("returns 'unknown' for null input", () => {
    expect(extractVersion(null, DOCKER_PATTERN)).toBe("unknown");
  });

  it("returns 'unknown' for empty string input", () => {
    expect(extractVersion("", DOCKER_PATTERN)).toBe("unknown");
  });

  // ── No match ─────────────────────────────────────────────────────────────

  it("returns 'unknown' when pattern has no match", () => {
    expect(extractVersion("hello world", DOCKER_PATTERN)).toBe("unknown");
  });

  it("returns 'unknown' when pattern matches but has no capture group 1", () => {
    // Pattern with no capture group → match[1] is undefined → "unknown"
    expect(extractVersion("Docker version 24.0.7", /Docker version/)).toBe("unknown");
  });

  // ── Docker version strings ────────────────────────────────────────────────

  it("extracts semver from a Docker version string", () => {
    const raw = "Docker version 24.0.7, build afdd53b4e3";
    expect(extractVersion(raw, DOCKER_PATTERN)).toBe("24.0.7");
  });

  it("extracts semver from a Docker version string with different version", () => {
    const raw = "Docker version 20.10.23, build 7155243";
    expect(extractVersion(raw, DOCKER_PATTERN)).toBe("20.10.23");
  });

  it("extracts semver from a Docker version string with triple-digit patch", () => {
    const raw = "Docker version 1.13.0, build 49bf474";
    expect(extractVersion(raw, DOCKER_PATTERN)).toBe("1.13.0");
  });

  // ── Compose version strings ───────────────────────────────────────────────

  it("extracts version from a Compose version string", () => {
    const raw = "v2.23.3";
    expect(extractVersion(raw, SEMVER_PATTERN)).toBe("2.23.3");
  });

  it("extracts from bare semver string", () => {
    expect(extractVersion("2.23.3", SEMVER_PATTERN)).toBe("2.23.3");
  });

  // ── Pattern matching semantics ────────────────────────────────────────────

  it("only returns capture group [1], not the full match", () => {
    const raw = "Docker version 24.0.7, build abc";
    // Pattern captures just the version, not 'Docker version '
    const result = extractVersion(raw, DOCKER_PATTERN);
    expect(result).not.toContain("Docker");
    expect(result).toBe("24.0.7");
  });

  it("matches from anywhere in the string (no anchoring)", () => {
    const raw = "prefix Docker version 99.0.1 suffix";
    expect(extractVersion(raw, DOCKER_PATTERN)).toBe("99.0.1");
  });
});
