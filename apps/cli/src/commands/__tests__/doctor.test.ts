/**
 * Unit tests for the doctor command utilities.
 *
 * The doctor command contains a `compareSemver` helper that is a pure
 * function with no side effects. Testing it in isolation is straightforward
 * and important: version comparison bugs can silently accept an old Docker
 * Compose that causes deploy failures.
 *
 * Coverage:
 *   - compareSemver(): a < b  → -1
 *   - compareSemver(): a == b → 0
 *   - compareSemver(): a > b  → 1
 *   - compareSemver(): major version difference dominates
 *   - compareSemver(): minor version difference dominates
 *   - compareSemver(): patch version is the tiebreaker
 *   - compareSemver(): missing patch component treated as 0
 *   - compareSemver(): double-digit version components
 *   - compareSemver(): specific production values (MIN_COMPOSE_VERSION check)
 */

import { describe, it, expect } from "vitest";
import { compareSemver } from "../../utils/exec.js";

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe("compareSemver", () => {
  // ── Equal ────────────────────────────────────────────────────────────────

  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });

  it("returns 0 for equal versions with double-digit parts", () => {
    expect(compareSemver("2.23.1", "2.23.1")).toBe(0);
  });

  // ── a < b ────────────────────────────────────────────────────────────────

  it("returns -1 when major is lower", () => {
    expect(compareSemver("1.99.99", "2.0.0")).toBe(-1);
  });

  it("returns -1 when minor is lower (same major)", () => {
    expect(compareSemver("2.22.9", "2.23.0")).toBe(-1);
  });

  it("returns -1 when patch is lower (same major.minor)", () => {
    expect(compareSemver("2.23.0", "2.23.1")).toBe(-1);
  });

  it("returns -1 for 0.0.0 vs 0.0.1", () => {
    expect(compareSemver("0.0.0", "0.0.1")).toBe(-1);
  });

  // ── a > b ────────────────────────────────────────────────────────────────

  it("returns 1 when major is higher", () => {
    expect(compareSemver("3.0.0", "2.99.99")).toBe(1);
  });

  it("returns 1 when minor is higher (same major)", () => {
    expect(compareSemver("2.24.0", "2.23.9")).toBe(1);
  });

  it("returns 1 when patch is higher (same major.minor)", () => {
    expect(compareSemver("2.23.2", "2.23.1")).toBe(1);
  });

  // ── Missing patch component ───────────────────────────────────────────────

  it("treats missing patch as 0 — '2.23' equals '2.23.0'", () => {
    expect(compareSemver("2.23", "2.23.0")).toBe(0);
  });

  it("treats missing patch as 0 — '2.23' is less than '2.23.1'", () => {
    expect(compareSemver("2.23", "2.23.1")).toBe(-1);
  });

  it("treats missing patch as 0 — '2.24' is greater than '2.23.9'", () => {
    expect(compareSemver("2.24", "2.23.9")).toBe(1);
  });

  // ── Real-world: MIN_COMPOSE_VERSION check ────────────────────────────────

  it("correctly identifies compose 2.23.0 as below minimum 2.23.1", () => {
    expect(compareSemver("2.23.0", "2.23.1")).toBe(-1);
  });

  it("correctly identifies compose 2.23.1 as meeting minimum 2.23.1", () => {
    expect(compareSemver("2.23.1", "2.23.1")).toBe(0);
  });

  it("correctly identifies compose 2.23.2 as exceeding minimum 2.23.1", () => {
    expect(compareSemver("2.23.2", "2.23.1")).toBe(1);
  });

  it("correctly identifies compose 2.24.0 as exceeding minimum 2.23.1", () => {
    expect(compareSemver("2.24.0", "2.23.1")).toBe(1);
  });

  it("correctly identifies compose 3.0.0 as exceeding minimum 2.23.1", () => {
    expect(compareSemver("3.0.0", "2.23.1")).toBe(1);
  });
});
