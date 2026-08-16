/**
 * Unit tests for whenClauseLabel.
 *
 * `whenClauseLabel(when)` converts an `ActiveOverlay["when"]` to a
 * human-readable string used in compiler diagnostics and overlay resolution.
 *
 * Input types:
 *   - `string[]`          → AND clause  → `"when: a + b"`
 *   - `{ any: string[] }` → OR  clause  → `"any: a | b"`
 *
 * Note: the "when: " and "any: " prefixes distinguish this function from
 * `whenLabel` in apps.ts, which uses the same " + " / " | " separators
 * but without the keyword prefix.
 */

import { describe, it, expect } from "vitest";
import { whenClauseLabel } from "../compile.js";

// ---------------------------------------------------------------------------
// AND clause — array input
// ---------------------------------------------------------------------------

describe("whenClauseLabel — AND (array)", () => {
  it("formats single-item AND clause", () => {
    expect(whenClauseLabel(["app-a"])).toBe("when: app-a");
  });

  it("formats two-item AND clause with ' + ' separator", () => {
    expect(whenClauseLabel(["app-a", "app-b"])).toBe("when: app-a + app-b");
  });

  it("formats three-item AND clause", () => {
    expect(whenClauseLabel(["app-a", "app-b", "app-c"])).toBe(
      "when: app-a + app-b + app-c",
    );
  });

  it("empty AND array produces 'when: ' with empty join", () => {
    expect(whenClauseLabel([])).toBe("when: ");
  });

  it("preserves app name with hyphens and numbers", () => {
    expect(whenClauseLabel(["my-app-v2"])).toBe("when: my-app-v2");
  });

  it("result starts with 'when: ' prefix (not 'any:')", () => {
    const label = whenClauseLabel(["some-app"]);
    expect(label.startsWith("when: ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OR clause — { any: string[] } input
// ---------------------------------------------------------------------------

describe("whenClauseLabel — OR (object)", () => {
  it("formats single-item OR clause", () => {
    expect(whenClauseLabel({ any: ["app-a"] })).toBe("any: app-a");
  });

  it("formats two-item OR clause with ' | ' separator", () => {
    expect(whenClauseLabel({ any: ["app-a", "app-b"] })).toBe("any: app-a | app-b");
  });

  it("formats three-item OR clause", () => {
    expect(whenClauseLabel({ any: ["app-a", "app-b", "app-c"] })).toBe(
      "any: app-a | app-b | app-c",
    );
  });

  it("empty OR array produces 'any: ' with empty join", () => {
    expect(whenClauseLabel({ any: [] })).toBe("any: ");
  });

  it("result starts with 'any: ' prefix (not 'when:')", () => {
    const label = whenClauseLabel({ any: ["some-app"] });
    expect(label.startsWith("any: ")).toBe(true);
  });

  it("preserves app name with underscores", () => {
    expect(whenClauseLabel({ any: ["my_service"] })).toBe("any: my_service");
  });
});

// ---------------------------------------------------------------------------
// Discriminator — AND vs OR distinction
// ---------------------------------------------------------------------------

describe("whenClauseLabel — AND vs OR discrimination", () => {
  it("array input always uses 'when:' not 'any:'", () => {
    const label = whenClauseLabel(["x", "y"]);
    expect(label).not.toContain("any:");
    expect(label).toContain("when:");
  });

  it("object input always uses 'any:' not 'when:'", () => {
    const label = whenClauseLabel({ any: ["x", "y"] });
    expect(label).not.toContain("when:");
    expect(label).toContain("any:");
  });

  it("AND separator is ' + ', OR separator is ' | '", () => {
    expect(whenClauseLabel(["x", "y"])).toContain(" + ");
    expect(whenClauseLabel({ any: ["x", "y"] })).toContain(" | ");
  });
});
