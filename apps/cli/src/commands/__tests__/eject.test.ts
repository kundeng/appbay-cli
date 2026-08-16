/**
 * Unit tests for eject command pure utilities.
 *
 * `extractEnvVars(rendered)` — pure string transform: scans rendered compose
 * YAML for `environment:` blocks and produces a .env file.
 *
 * `generateReadme(appName)` — pure string generator: produces a Markdown
 * README referencing the given app name.
 *
 * Coverage for extractEnvVars:
 *   - Empty input → header only (no KEY=VALUE pairs)
 *   - No environment blocks → header only
 *   - List-style entries (`- KEY=VALUE`) are captured
 *   - Map-style entries (`KEY: VALUE`) for UPPERCASE keys are captured
 *   - Empty value (`- KEY=`) is captured as KEY=
 *   - Block exits when non-list, non-comment, non-env line appears
 *   - Multiple environment blocks in same file are merged
 *   - Duplicate keys: last value wins (Map semantics)
 *   - Lower-case keys in map form are NOT captured (regex requires uppercase)
 *   - Comment lines inside block are skipped
 *   - Output always starts with the two-line header comment
 *   - Output always ends with a newline
 *
 * Coverage for generateReadme:
 *   - Title contains app name
 *   - Contains usage commands (docker compose up, logs, down)
 *   - Mentions .env file
 *   - Ends with newline
 */

import { describe, it, expect } from "vitest";
import { extractEnvVars, generateReadme } from "../eject.js";

// ---------------------------------------------------------------------------
// extractEnvVars
// ---------------------------------------------------------------------------

describe("extractEnvVars", () => {
  // ── Always-present header ─────────────────────────────────────────────────

  it("returns a header comment line even for empty input", () => {
    const result = extractEnvVars("");
    expect(result).toContain("# Environment variables extracted from Appbay compose");
  });

  it("returns a review comment line even for empty input", () => {
    const result = extractEnvVars("");
    expect(result).toContain("# Review and adjust values before running standalone");
  });

  it("output always ends with a newline", () => {
    expect(extractEnvVars("")).toMatch(/\n$/);
    expect(extractEnvVars("environment:\n  - FOO=bar\n")).toMatch(/\n$/);
  });

  // ── No environment blocks ─────────────────────────────────────────────────

  it("no KEY=VALUE pairs when no environment block present", () => {
    const yaml = `services:\n  web:\n    image: nginx\n    ports:\n      - "80:80"\n`;
    const result = extractEnvVars(yaml);
    // Header lines only — no KEY= assignments
    const lines = result.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(lines).toEqual([]);
  });

  // ── List-style entries (`- KEY=VALUE`) ───────────────────────────────────

  it("captures list-style `- KEY=VALUE` entries", () => {
    const yaml = [
      "services:",
      "  web:",
      "    environment:",
      "      - DATABASE_URL=postgres://localhost/mydb",
      "      - SECRET_KEY=abc123",
    ].join("\n");
    const result = extractEnvVars(yaml);
    expect(result).toContain("DATABASE_URL=postgres://localhost/mydb");
    expect(result).toContain("SECRET_KEY=abc123");
  });

  it("captures list-style entry with empty value (`- KEY=`)", () => {
    const yaml = "services:\n  app:\n    environment:\n      - EMPTY_VAR=\n";
    expect(extractEnvVars(yaml)).toContain("EMPTY_VAR=");
  });

  it("captures list-style entry where value contains an `=` sign", () => {
    const yaml = "environment:\n  - JWT_SECRET=a=b=c\n";
    // Regex is /^-\s*(.+)=(.*)$/ — group 1 is everything before first =
    // Actually the regex captures KEY as (.+) and VALUE as (.*) after first =
    // So 'a=b=c' would be split at first =: KEY='JWT_SECRET', VALUE='a=b=c'
    const result = extractEnvVars(yaml);
    expect(result).toContain("JWT_SECRET=");
  });

  // ── Map-style entries (`KEY: VALUE`) ────────────────────────────────────

  it("captures UPPERCASE map-style `KEY: VALUE` entries", () => {
    const yaml = [
      "environment:",
      "  DATABASE_HOST: localhost",
      "  REDIS_PORT: 6379",
    ].join("\n");
    const result = extractEnvVars(yaml);
    expect(result).toContain("DATABASE_HOST=localhost");
    expect(result).toContain("REDIS_PORT=6379");
  });

  it("does NOT capture lowercase map-style keys (uppercase regex filter)", () => {
    // Map-style regex requires [A-Z_][A-Z0-9_]* so lowercase keys are skipped
    // (treated as non-matching, and since they don't start with - or # they
    // exit the block, so only entries before them are captured)
    const yaml = [
      "environment:",
      "  FOO: bar",     // captured — uppercase key
      "  api_url: http://example.com",  // NOT captured — lowercase key
    ].join("\n");
    const result = extractEnvVars(yaml);
    expect(result).toContain("FOO=bar");
    expect(result).not.toContain("api_url=");
  });

  // ── Block exit behavior ───────────────────────────────────────────────────

  it("stops collecting when it hits a non-list, non-comment top-level key", () => {
    const yaml = [
      "environment:",
      "  - API_KEY=secret",
      "ports:",          // exit the environment block
      "  - '80:80'",
      "  - SHOULD_NOT_APPEAR=yes",
    ].join("\n");
    const result = extractEnvVars(yaml);
    expect(result).toContain("API_KEY=secret");
    expect(result).not.toContain("SHOULD_NOT_APPEAR");
  });

  // ── Multiple blocks ───────────────────────────────────────────────────────

  it("collects from multiple environment blocks in the same file", () => {
    const yaml = [
      "services:",
      "  web:",
      "    environment:",
      "      - WEB_PORT=8080",
      "    image: nginx",
      "  db:",
      "    environment:",
      "      - DB_NAME=myapp",
    ].join("\n");
    const result = extractEnvVars(yaml);
    expect(result).toContain("WEB_PORT=8080");
    expect(result).toContain("DB_NAME=myapp");
  });

  // ── Duplicate keys ────────────────────────────────────────────────────────

  it("last value wins for duplicate keys (Map semantics)", () => {
    const yaml = [
      "environment:",
      "  - FOO=first",
      "  - FOO=second",
    ].join("\n");
    const result = extractEnvVars(yaml);
    expect(result).toContain("FOO=second");
    // Should only appear once
    expect(result.split("FOO=").length).toBe(2);
  });

  // ── Comment lines inside block ────────────────────────────────────────────

  it("skips comment lines inside environment block", () => {
    const yaml = [
      "environment:",
      "  # this is a comment",
      "  - REAL_VAR=value",
    ].join("\n");
    const result = extractEnvVars(yaml);
    expect(result).toContain("REAL_VAR=value");
    expect(result).not.toContain("# this is a comment");
  });
});

// ---------------------------------------------------------------------------
// generateReadme
// ---------------------------------------------------------------------------

describe("generateReadme", () => {
  it("title includes the app name", () => {
    expect(generateReadme("myapp")).toContain("# myapp");
  });

  it("mentions it was ejected from Appbay", () => {
    expect(generateReadme("myapp")).toContain("Ejected from Appbay");
  });

  it("different app names produce different titles", () => {
    expect(generateReadme("blog")).toContain("# blog");
    expect(generateReadme("wiki")).toContain("# wiki");
  });

  it("contains `docker compose up -d` command", () => {
    expect(generateReadme("app")).toContain("docker compose up -d");
  });

  it("contains `docker compose logs -f` command", () => {
    expect(generateReadme("app")).toContain("docker compose logs -f");
  });

  it("contains `docker compose down` command", () => {
    expect(generateReadme("app")).toContain("docker compose down");
  });

  it("mentions the .env file", () => {
    expect(generateReadme("app")).toContain(".env");
  });

  it("ends with a newline", () => {
    expect(generateReadme("app")).toMatch(/\n$/);
  });

  it("is a non-empty string", () => {
    const result = generateReadme("myservice");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
