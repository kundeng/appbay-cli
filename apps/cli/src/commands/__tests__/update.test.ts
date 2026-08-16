/**
 * Unit tests for the update command's compareSemver helper.
 *
 * `compareSemver(a, b)` — pure semver comparison:
 *   - Returns negative when a < b
 *   - Returns 0 when a === b
 *   - Returns positive when a > b
 *
 * The function strips leading 'v' prefixes and compares major.minor.patch
 * numerically. Missing components default to 0 (e.g., "1.2" === "1.2.0").
 * Major version differences dominate minor, which dominates patch.
 *
 * Coverage:
 *   - Equal versions → 0
 *   - Major version difference (a > b) → positive
 *   - Major version difference (a < b) → negative
 *   - Minor version difference → correct sign
 *   - Patch version difference → correct sign
 *   - 'v' prefix stripped on both sides
 *   - Mixed prefix: one with 'v', one without
 *   - Missing patch component defaults to 0
 *   - Major dominates minor (1.9.9 < 2.0.0)
 *   - Minor dominates patch (1.1.9 < 1.2.0)
 *   - Large version numbers compared numerically (not lexicographically)
 *   - Return value sign only matters, not magnitude
 */

import { describe, it, expect } from "vitest";
import { compareSemver } from "../../utils/exec.js";

describe("compareSemver", () => {
  // ── Equal versions ────────────────────────────────────────────────────────

  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns 0 for equal versions with v prefix", () => {
    expect(compareSemver("v1.2.3", "v1.2.3")).toBe(0);
  });

  it("returns 0 for 0.0.0", () => {
    expect(compareSemver("0.0.0", "0.0.0")).toBe(0);
  });

  // ── a > b (positive return) ───────────────────────────────────────────────

  it("returns positive when a has greater major version", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("returns positive when a has greater minor version (same major)", () => {
    expect(compareSemver("1.3.0", "1.2.9")).toBeGreaterThan(0);
  });

  it("returns positive when a has greater patch version (same major.minor)", () => {
    expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
  });

  // ── a < b (negative return) ───────────────────────────────────────────────

  it("returns negative when a has lesser major version", () => {
    expect(compareSemver("1.9.9", "2.0.0")).toBeLessThan(0);
  });

  it("returns negative when a has lesser minor version (same major)", () => {
    expect(compareSemver("1.2.9", "1.3.0")).toBeLessThan(0);
  });

  it("returns negative when a has lesser patch version (same major.minor)", () => {
    expect(compareSemver("1.2.3", "1.2.4")).toBeLessThan(0);
  });

  // ── v prefix stripping ────────────────────────────────────────────────────

  it("strips leading v prefix before comparison", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
  });

  it("strips v prefix on both sides consistently", () => {
    expect(compareSemver("v2.0.0", "v1.9.9")).toBeGreaterThan(0);
  });

  it("works when only a has v prefix", () => {
    expect(compareSemver("v1.0.0", "1.0.0")).toBe(0);
  });

  it("works when only b has v prefix", () => {
    expect(compareSemver("1.0.0", "v1.0.0")).toBe(0);
  });

  // ── Missing components default to 0 ──────────────────────────────────────

  it("treats missing patch as 0 — '1.2' equals '1.2.0'", () => {
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
  });

  it("treats missing patch as 0 — '1.2.1' is greater than '1.2'", () => {
    expect(compareSemver("1.2.1", "1.2")).toBeGreaterThan(0);
  });

  // ── Component priority ────────────────────────────────────────────────────

  it("major version dominates over minor (1.9.9 < 2.0.0)", () => {
    expect(compareSemver("1.9.9", "2.0.0")).toBeLessThan(0);
  });

  it("minor version dominates over patch (1.1.9 < 1.2.0)", () => {
    expect(compareSemver("1.1.9", "1.2.0")).toBeLessThan(0);
  });

  // ── Numerical (not lexicographic) comparison ──────────────────────────────

  it("compares numerically: 10 > 9 (not lexicographic '10' < '9')", () => {
    expect(compareSemver("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });

  it("compares major numerically: 10.0.0 > 9.0.0", () => {
    expect(compareSemver("10.0.0", "9.0.0")).toBeGreaterThan(0);
  });

  // ── Real-world version pairs ──────────────────────────────────────────────

  it("correctly orders typical release progression", () => {
    // 0.1.0 < 0.2.0 < 1.0.0 < 1.0.1 < 2.0.0
    expect(compareSemver("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareSemver("0.2.0", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareSemver("1.0.1", "2.0.0")).toBeLessThan(0);
  });

  it("handles the same-as-current case (used in selfUpdate guard)", () => {
    // selfUpdate checks: compareSemver(latest, current) <= 0 → already up to date
    const current = "0.5.0";
    expect(compareSemver(current, current)).toBe(0);       // same → no update
    expect(compareSemver("0.4.9", current)).toBeLessThan(0); // older → no update
    expect(compareSemver("0.5.1", current)).toBeGreaterThan(0); // newer → do update
  });
});
