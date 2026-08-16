/**
 * Unit tests for the LCS-based diff utilities in plan.ts.
 *
 * lcsTable(a, b):
 *   - Empty inputs → all-zero table
 *   - Identical arrays → LCS length equals array length
 *   - Disjoint arrays → LCS length is 0
 *   - Partial overlap → table[m][n] equals LCS length
 *   - Single identical element → table[1][1] = 1
 *   - Order matters (LCS ≠ set intersection)
 *
 * computeDiffLines(oldLines, newLines):
 *   - Identical arrays → all "context" lines
 *   - Empty old, non-empty new → all "add" lines
 *   - Non-empty old, empty new → all "remove" lines
 *   - One line added at end
 *   - One line removed from middle
 *   - Lines replaced (remove old + add new)
 *   - Mixed add/remove/context
 *   - Result is in forward order (not reversed)
 *
 * formatUnifiedDiff(appName, diffLines):
 *   - Header lines use the appName path
 *   - "add" lines are prefixed with "+"
 *   - "remove" lines are prefixed with "-"
 *   - "context" lines are prefixed with " " (space)
 *   - Empty diffLines → just header
 *   - Lines joined with "\n" (no trailing newline)
 */

import { describe, it, expect } from "vitest";
import { lcsTable, computeDiffLines, formatUnifiedDiff } from "../plan.js";
import type { DiffLine } from "../plan.js";

// ---------------------------------------------------------------------------
// lcsTable
// ---------------------------------------------------------------------------

describe("lcsTable", () => {
  it("returns a 1x1 zero table for two empty arrays", () => {
    const t = lcsTable([], []);
    expect(t).toEqual([[0]]);
  });

  it("has dimensions (m+1) × (n+1)", () => {
    const t = lcsTable(["a", "b"], ["x", "y", "z"]);
    expect(t.length).toBe(3);        // m+1 = 3
    expect(t[0].length).toBe(4);    // n+1 = 4
  });

  it("table[m][n] equals LCS length for identical arrays", () => {
    const arr = ["a", "b", "c"];
    const t = lcsTable(arr, arr);
    expect(t[3][3]).toBe(3);
  });

  it("table[m][n] is 0 for completely disjoint arrays", () => {
    const t = lcsTable(["a", "b"], ["x", "y"]);
    expect(t[2][2]).toBe(0);
  });

  it("computes LCS length correctly for partial overlap", () => {
    // LCS of ["a","b","c"] and ["b","c","d"] is ["b","c"], length 2
    const t = lcsTable(["a", "b", "c"], ["b", "c", "d"]);
    expect(t[3][3]).toBe(2);
  });

  it("handles single-element match", () => {
    const t = lcsTable(["x"], ["x"]);
    expect(t[1][1]).toBe(1);
  });

  it("handles single-element mismatch", () => {
    const t = lcsTable(["x"], ["y"]);
    expect(t[1][1]).toBe(0);
  });

  it("LCS respects order — not set intersection", () => {
    // ["b","a"] vs ["a","b"]: LCS is either "a" or "b" (length 1, not 2)
    const t = lcsTable(["b", "a"], ["a", "b"]);
    expect(t[2][2]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeDiffLines
// ---------------------------------------------------------------------------

describe("computeDiffLines", () => {
  it("produces all context lines for identical input", () => {
    const lines = ["a:", "  b: 1", "  c: 2"];
    const diff = computeDiffLines(lines, lines);
    expect(diff.every((d) => d.type === "context")).toBe(true);
    expect(diff.map((d) => d.content)).toEqual(lines);
  });

  it("produces all add lines when old is empty", () => {
    const diff = computeDiffLines([], ["x", "y"]);
    expect(diff.map((d) => d.type)).toEqual(["add", "add"]);
    expect(diff.map((d) => d.content)).toEqual(["x", "y"]);
  });

  it("produces all remove lines when new is empty", () => {
    const diff = computeDiffLines(["x", "y"], []);
    expect(diff.map((d) => d.type)).toEqual(["remove", "remove"]);
    expect(diff.map((d) => d.content)).toEqual(["x", "y"]);
  });

  it("detects a single line appended at the end", () => {
    const diff = computeDiffLines(["a", "b"], ["a", "b", "c"]);
    const types = diff.map((d) => d.type);
    expect(types).toEqual(["context", "context", "add"]);
    expect(diff[2].content).toBe("c");
  });

  it("detects a single line prepended at the start", () => {
    const diff = computeDiffLines(["b", "c"], ["a", "b", "c"]);
    const types = diff.map((d) => d.type);
    expect(types).toEqual(["add", "context", "context"]);
    expect(diff[0].content).toBe("a");
  });

  it("detects a removed line in the middle", () => {
    const diff = computeDiffLines(["a", "b", "c"], ["a", "c"]);
    const types = diff.map((d) => d.type);
    expect(types).toContain("remove");
    const removed = diff.filter((d) => d.type === "remove");
    expect(removed[0].content).toBe("b");
  });

  it("produces remove+add for a replaced line", () => {
    const diff = computeDiffLines(["image: nginx:1.24"], ["image: nginx:1.25"]);
    expect(diff.some((d) => d.type === "remove" && d.content === "image: nginx:1.24")).toBe(true);
    expect(diff.some((d) => d.type === "add" && d.content === "image: nginx:1.25")).toBe(true);
  });

  it("result is in forward order (first line first)", () => {
    const diff = computeDiffLines(["a", "b"], ["a", "b", "c"]);
    expect(diff[0].content).toBe("a");
    expect(diff[diff.length - 1].content).toBe("c");
  });

  it("handles empty-to-empty (produces empty array)", () => {
    const diff = computeDiffLines([], []);
    expect(diff).toEqual([]);
  });

  it("complex diff preserves context lines correctly", () => {
    const old = ["version: '3'", "services:", "  web:", "    image: nginx:1.24"];
    const neu = ["version: '3'", "services:", "  web:", "    image: nginx:1.25"];
    const diff = computeDiffLines(old, neu);
    const contextLines = diff.filter((d) => d.type === "context").map((d) => d.content);
    expect(contextLines).toContain("version: '3'");
    expect(contextLines).toContain("services:");
  });
});

// ---------------------------------------------------------------------------
// formatUnifiedDiff
// ---------------------------------------------------------------------------

describe("formatUnifiedDiff", () => {
  it("produces header lines with the app name", () => {
    const result = formatUnifiedDiff("myapp", []);
    expect(result).toContain("--- a/myapp/docker-compose.rendered.yml");
    expect(result).toContain("+++ b/myapp/docker-compose.rendered.yml");
  });

  it("prefixes add lines with '+'", () => {
    const diffLines: DiffLine[] = [{ type: "add", content: "  new: line" }];
    const result = formatUnifiedDiff("app", diffLines);
    expect(result).toContain("+  new: line");
  });

  it("prefixes remove lines with '-'", () => {
    const diffLines: DiffLine[] = [{ type: "remove", content: "  old: line" }];
    const result = formatUnifiedDiff("app", diffLines);
    expect(result).toContain("-  old: line");
  });

  it("prefixes context lines with a space", () => {
    // Context lines only appear inside hunks, which require at least one change.
    const diffLines: DiffLine[] = [
      { type: "context", content: "unchanged" },
      { type: "add", content: "added-line" },
    ];
    const result = formatUnifiedDiff("app", diffLines);
    expect(result).toContain(" unchanged");
  });

  it("produces only headers for empty diffLines", () => {
    const result = formatUnifiedDiff("myapp", []);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
  });

  it("uses app name with hyphens/slashes correctly", () => {
    const result = formatUnifiedDiff("my-app", []);
    expect(result).toContain("a/my-app/docker-compose.rendered.yml");
    expect(result).toContain("b/my-app/docker-compose.rendered.yml");
  });

  it("joins lines with newline (no trailing newline for empty diff)", () => {
    const result = formatUnifiedDiff("app", []);
    expect(result.endsWith("\n")).toBe(false);
    expect(result.split("\n").length).toBe(2);
  });

  it("renders a complete mixed diff correctly (with hunk header)", () => {
    const diffLines: DiffLine[] = [
      { type: "context", content: "services:" },
      { type: "remove", content: "  image: nginx:1.24" },
      { type: "add", content: "  image: nginx:1.25" },
    ];
    const result = formatUnifiedDiff("blog", diffLines);
    const lines = result.split("\n");
    expect(lines[0]).toBe("--- a/blog/docker-compose.rendered.yml");
    expect(lines[1]).toBe("+++ b/blog/docker-compose.rendered.yml");
    // lines[2] is the @@ hunk header inserted by the unified diff format
    expect(lines[2]).toMatch(/^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@$/);
    expect(lines[3]).toBe(" services:");
    expect(lines[4]).toBe("-  image: nginx:1.24");
    expect(lines[5]).toBe("+  image: nginx:1.25");
  });
});
