/**
 * Plan/diff generator -- compares rendered compose output against the
 * current state on disk (or null for first deploy) and produces a
 * human-readable unified diff with secret values redacted.
 *
 * See design.md "Plan Generator" and agents.md "Primary design goal"
 * for canonical reference.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input to the plan generator. */
export interface PlanInput {
  /** App name (directory name). */
  appName: string;
  /** New rendered compose YAML. */
  rendered: string;
  /** Current compose YAML on disk (null if first deploy). */
  current: string | null;
  /** Additional regex patterns to redact (merged with defaults). */
  secretPatterns?: RegExp[];
}

/** A single line in a structured diff. */
export interface DiffLine {
  /** Line type: add, remove, or context (unchanged). */
  type: "add" | "remove" | "context";
  /** Line content with secrets redacted. */
  content: string;
  /** Line number in the source (new file for adds, old file for removes). */
  lineNumber?: number;
}

/** Plan output for a single app. */
export interface Plan {
  /** App name. */
  appName: string;
  /** High-level status of the app. */
  status: "new" | "changed" | "unchanged" | "removed";
  /** Unified diff string with secrets redacted (null if unchanged). */
  diff: string | null;
  /** Structured diff lines. */
  diffLines: DiffLine[];
  /** SHA-256 hash of the rendered compose (for deploy record). */
  hash: string;
}

// ---------------------------------------------------------------------------
// Default secret patterns
// ---------------------------------------------------------------------------

/**
 * Default patterns for detecting secret values in environment variable
 * assignments.  Each pattern matches a full `KEY=VALUE` pair where the
 * key suggests a secret.  The value portion is replaced with `[REDACTED]`.
 */
const DEFAULT_SECRET_KEY_PATTERNS: RegExp[] = [
  // Common secret env var key names (case-insensitive).
  // Matches: PASSWORD=..., DB_PASSWORD=..., SECRET_KEY=..., etc.
  /^(\s*-?\s*\w*(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)\w*=).+$/i,
];

/**
 * Patterns for secret URI schemes that should always be redacted.
 */
const SECRET_URI_PATTERNS: RegExp[] = [
  // Secret vault URI values: vault://..., keepass://..., sops://...
  /^(\s*-?\s*\w+=)(vault:\/\/.+|keepass:\/\/.+|sops:\/\/.+)$/i,
];

/**
 * Pattern for long base64-encoded values after `=` in env var assignments.
 * Matches values that are 20+ characters of base64 alphabet.
 */
const BASE64_SECRET_PATTERN: RegExp =
  /^(\s*-?\s*\w+=)([A-Za-z0-9+/]{20,}={0,2})$/;

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

/**
 * Redact secret values from a string.
 *
 * Scans each line for patterns that indicate secret values and replaces
 * the value portion with `[REDACTED]`, keeping the key visible.
 *
 * Example: `DB_PASSWORD=s3cr3t123` becomes `DB_PASSWORD=[REDACTED]`
 *
 * @param text - The text to redact.
 * @param patterns - Additional patterns to apply (merged with defaults).
 * @returns The text with secret values replaced.
 */
export function redactSecrets(text: string, patterns?: RegExp[]): string {
  const allPatterns: RegExp[] = [
    ...DEFAULT_SECRET_KEY_PATTERNS,
    ...SECRET_URI_PATTERNS,
    BASE64_SECRET_PATTERN,
    ...(patterns ?? []),
  ];

  return text
    .split("\n")
    .map((line) => {
      for (const pattern of allPatterns) {
        const match = line.match(pattern);
        if (match && match[1]) {
          return `${match[1]}[REDACTED]`;
        }
      }
      return line;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Simple LCS-based diff algorithm
// ---------------------------------------------------------------------------

/**
 * Compute the longest common subsequence (LCS) table for two arrays of
 * strings.  Returns a 2D array where `table[i][j]` is the length of
 * the LCS of `a[0..i-1]` and `b[0..j-1]`.
 */
export function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }

  return table;
}

/**
 * Produce structured diff lines from two arrays of strings using LCS
 * backtracking.
 */
export function computeDiffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const table = lcsTable(oldLines, newLines);
  const result: DiffLine[] = [];

  let i = oldLines.length;
  let j = newLines.length;

  // Backtrack through the LCS table to produce diff operations.
  const stack: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: "context", content: oldLines[i - 1], lineNumber: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      stack.push({ type: "add", content: newLines[j - 1], lineNumber: j });
      j--;
    } else {
      stack.push({ type: "remove", content: oldLines[i - 1], lineNumber: i });
      i--;
    }
  }

  // Reverse because we built it backwards.
  stack.reverse();
  result.push(...stack);

  return result;
}

/**
 * Format structured diff lines into a proper unified diff string with
 * `@@ -oldStart,oldCount +newStart,newCount @@` hunk headers.
 *
 * Hunk headers are required for compatibility with `patch`, `git apply`,
 * and standard diff viewers (GitHub, delta, VS Code).
 *
 * @param appName      App name used in the --- / +++ file headers.
 * @param diffLines    Structured diff lines from computeDiffLines.
 * @param contextLines Unchanged lines to include around each changed region
 *                     (default: 3, matching GNU diff behaviour).
 */
export function formatUnifiedDiff(
  appName: string,
  diffLines: DiffLine[],
  contextLines = 3,
): string {
  // ── Step 1: Annotate each line with its old and new file line numbers ──
  type AnnotatedLine = DiffLine & { oldLine: number | null; newLine: number | null };

  const annotated: AnnotatedLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const dl of diffLines) {
    switch (dl.type) {
      case "context":
        annotated.push({ ...dl, oldLine, newLine });
        oldLine++;
        newLine++;
        break;
      case "remove":
        annotated.push({ ...dl, oldLine, newLine: null });
        oldLine++;
        break;
      case "add":
        annotated.push({ ...dl, oldLine: null, newLine });
        newLine++;
        break;
    }
  }

  // ── Step 2: Locate changed-line indices ───────────────────────────────
  const changedIndices = annotated
    .map((dl, i) => (dl.type !== "context" ? i : -1))
    .filter((i) => i !== -1);

  const header = [
    `--- a/${appName}/docker-compose.rendered.yml`,
    `+++ b/${appName}/docker-compose.rendered.yml`,
  ];

  if (changedIndices.length === 0) {
    return header.join("\n");
  }

  // ── Step 3: Group changed indices into context windows (hunks) ────────
  // Two changes whose context windows overlap or are adjacent are merged
  // into a single hunk, matching GNU diff behaviour.
  const hunkRanges: Array<{ start: number; end: number }> = [];
  let hunkStart = Math.max(0, changedIndices[0]! - contextLines);
  let hunkEnd = Math.min(annotated.length - 1, changedIndices[0]! + contextLines);

  for (let k = 1; k < changedIndices.length; k++) {
    const idx = changedIndices[k]!;
    const nextStart = Math.max(0, idx - contextLines);

    if (nextStart <= hunkEnd + 1) {
      // Overlapping or adjacent context windows — extend current hunk.
      hunkEnd = Math.min(annotated.length - 1, idx + contextLines);
    } else {
      hunkRanges.push({ start: hunkStart, end: hunkEnd });
      hunkStart = nextStart;
      hunkEnd = Math.min(annotated.length - 1, idx + contextLines);
    }
  }
  hunkRanges.push({ start: hunkStart, end: hunkEnd });

  // ── Step 4: Emit file headers then each hunk ──────────────────────────
  const output: string[] = header;

  for (const { start, end } of hunkRanges) {
    const hunkLines = annotated.slice(start, end + 1);

    // Count lines contributed by each side (context counts for both).
    const oldCount = hunkLines.filter((l) => l.type !== "add").length;
    const newCount = hunkLines.filter((l) => l.type !== "remove").length;

    // Starting position in each file.  When a side has no lines (pure
    // addition or pure deletion), the convention is position 0.
    const oldPos =
      oldCount === 0 ? 0 : (hunkLines.find((l) => l.oldLine !== null)?.oldLine ?? 1);
    const newPos =
      newCount === 0 ? 0 : (hunkLines.find((l) => l.newLine !== null)?.newLine ?? 1);

    output.push(`@@ -${oldPos},${oldCount} +${newPos},${newCount} @@`);

    for (const dl of hunkLines) {
      switch (dl.type) {
        case "add":
          output.push(`+${dl.content}`);
          break;
        case "remove":
          output.push(`-${dl.content}`);
          break;
        case "context":
          output.push(` ${dl.content}`);
          break;
      }
    }
  }

  return output.join("\n");
}

// ---------------------------------------------------------------------------
// Main plan generator
// ---------------------------------------------------------------------------

/**
 * Generate a plan comparing the newly rendered compose YAML against the
 * current state on disk.
 *
 * This is a pure function -- it does not read or write the filesystem.
 *
 * @param input - Plan generator input.
 * @returns A plan describing the action and diff for this app.
 */
export function generatePlan(input: PlanInput): Plan {
  const { appName, rendered, current, secretPatterns } = input;

  // Compute SHA-256 hash of the rendered compose for deploy records.
  const hash = createHash("sha256").update(rendered).digest("hex");

  // Determine status.
  const isNew = current === null;
  const isRemoved = rendered.trim() === "" && current !== null;
  const isUnchanged = !isNew && !isRemoved && rendered === current;

  if (isUnchanged) {
    return {
      appName,
      status: "unchanged",
      diff: null,
      diffLines: [],
      hash,
    };
  }

  if (isRemoved) {
    // Entire file is being removed -- show all lines as removals.
    const redactedCurrent = redactSecrets(current, secretPatterns);
    const currentLines = redactedCurrent.split("\n");
    const diffLines: DiffLine[] = currentLines.map((line, idx) => ({
      type: "remove" as const,
      content: line,
      lineNumber: idx + 1,
    }));

    return {
      appName,
      status: "removed",
      diff: formatUnifiedDiff(appName, diffLines),
      diffLines,
      hash,
    };
  }

  if (isNew) {
    // Entire file is new -- show all lines as additions.
    const redactedRendered = redactSecrets(rendered, secretPatterns);
    const renderedLines = redactedRendered.split("\n");
    const diffLines: DiffLine[] = renderedLines.map((line, idx) => ({
      type: "add" as const,
      content: line,
      lineNumber: idx + 1,
    }));

    return {
      appName,
      status: "new",
      diff: formatUnifiedDiff(appName, diffLines),
      diffLines,
      hash,
    };
  }

  // Changed -- compute a line-by-line diff with redacted secrets.
  const redactedCurrent = redactSecrets(current!, secretPatterns);
  const redactedRendered = redactSecrets(rendered, secretPatterns);

  const oldLines = redactedCurrent.split("\n");
  const newLines = redactedRendered.split("\n");

  const diffLines = computeDiffLines(oldLines, newLines);

  return {
    appName,
    status: "changed",
    diff: formatUnifiedDiff(appName, diffLines),
    diffLines,
    hash,
  };
}
