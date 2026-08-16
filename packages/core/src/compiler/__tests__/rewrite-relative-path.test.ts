/**
 * Unit tests for rewriteRelativePath in upstream-transform.ts.
 *
 * `rewriteRelativePath(relativePath, appName, appsDir, upstreamSource?)` — pure
 * path rewriting for upstream volume bind mounts:
 *   - Strips the leading "./" from relativePath
 *   - Derives the upstream directory from the upstreamSource filename by
 *     cutting at the last "/" (if no slash, upstream dir is empty/app root)
 *   - Returns `./apps/<appName>/<upstreamDir>/<pathWithinUpstream>` when there
 *     is an upstream directory
 *   - Returns `./apps/<appName>/<pathWithinUpstream>` when upstreamDir is empty
 *     (source has no "/" or upstreamSource is absent)
 *
 * The `_appsDir` parameter is unused in this function (hence the underscore
 * prefix) and can be any string.
 *
 * Coverage:
 *   - No upstreamSource → path rooted at app directory
 *   - upstreamSource without slash → same as no directory (app root)
 *   - upstreamSource with single subdirectory (e.g., "subdir/docker-compose.yml")
 *   - upstreamSource with nested subdirectory
 *   - relativePath with multiple path components ("./data/db")
 *   - appsDir parameter is ignored (does not appear in result)
 *   - Different appName values are reflected in output
 */

import { describe, it, expect } from "vitest";
import { rewriteRelativePath } from "../upstream-transform.js";

const APPS_DIR = "/opt/appbay/etc/apps"; // value is irrelevant (unused)

describe("rewriteRelativePath", () => {
  // ── No upstream source ────────────────────────────────────────────────────

  it("returns path relative to app root when no upstreamSource", () => {
    const result = rewriteRelativePath("./data", "jellyfin", APPS_DIR);
    expect(result).toBe("./apps/jellyfin/data");
  });

  it("handles multi-component path without upstream source", () => {
    const result = rewriteRelativePath("./data/db", "myapp", APPS_DIR);
    expect(result).toBe("./apps/myapp/data/db");
  });

  // ── upstreamSource without directory component ────────────────────────────

  it("treats source with no slash as empty upstream dir — same as no source", () => {
    const result = rewriteRelativePath("./data", "jellyfin", APPS_DIR, "docker-compose.yml");
    expect(result).toBe("./apps/jellyfin/data");
  });

  // ── upstreamSource with one directory level ───────────────────────────────

  it("prefixes with upstream subdirectory when source has one path segment", () => {
    const result = rewriteRelativePath(
      "./data",
      "jellyfin",
      APPS_DIR,
      "jellyfin-upstream/docker-compose.yml",
    );
    expect(result).toBe("./apps/jellyfin/jellyfin-upstream/data");
  });

  it("works with a differently named upstream directory", () => {
    const result = rewriteRelativePath(
      "./config",
      "myapp",
      APPS_DIR,
      "upstream-source/compose.yml",
    );
    expect(result).toBe("./apps/myapp/upstream-source/config");
  });

  // ── upstreamSource with nested directory ─────────────────────────────────

  it("uses full upstream directory path for nested sources", () => {
    const result = rewriteRelativePath(
      "./data",
      "myapp",
      APPS_DIR,
      "nested/sub/docker-compose.yml",
    );
    expect(result).toBe("./apps/myapp/nested/sub/data");
  });

  // ── relativePath with multiple components ────────────────────────────────

  it("preserves multi-component relative paths after './' is stripped", () => {
    const result = rewriteRelativePath(
      "./volumes/postgres/data",
      "postgres",
      APPS_DIR,
      "postgres-upstream/docker-compose.yml",
    );
    expect(result).toBe("./apps/postgres/postgres-upstream/volumes/postgres/data");
  });

  // ── appsDir parameter is not reflected in output ─────────────────────────

  it("appsDir is unused — different values produce the same output", () => {
    const r1 = rewriteRelativePath("./data", "myapp", "/path/a", "src/compose.yml");
    const r2 = rewriteRelativePath("./data", "myapp", "/path/b", "src/compose.yml");
    expect(r1).toBe(r2);
  });

  // ── appName variation ─────────────────────────────────────────────────────

  it("uses the appName in the output path", () => {
    const r1 = rewriteRelativePath("./data", "app-one", APPS_DIR);
    const r2 = rewriteRelativePath("./data", "app-two", APPS_DIR);
    expect(r1).toBe("./apps/app-one/data");
    expect(r2).toBe("./apps/app-two/data");
  });

  // ── Real-world usage ──────────────────────────────────────────────────────

  it("mirrors the example in the JSDoc comment", () => {
    // `./data` with app "jellyfin" and source "jellyfin-upstream/docker-compose.yml"
    // becomes `./apps/jellyfin/jellyfin-upstream/data`
    const result = rewriteRelativePath(
      "./data",
      "jellyfin",
      "/opt/appbay/etc/apps",
      "jellyfin-upstream/docker-compose.yml",
    );
    expect(result).toBe("./apps/jellyfin/jellyfin-upstream/data");
  });

  // ── appsRelPath parameter overrides the "apps" fallback prefix ────────────

  it("uses appsRelPath as prefix instead of 'apps' when provided", () => {
    // appsRelPath="../../etc/apps" replaces the default "apps" prefix
    const result = rewriteRelativePath(
      "./data",
      "myapp",
      APPS_DIR,
      undefined,
      "../../etc/apps",
    );
    expect(result).toBe("./../../etc/apps/myapp/data");
  });

  it("combines appsRelPath with upstream subdirectory correctly", () => {
    const result = rewriteRelativePath(
      "./config",
      "myapp",
      APPS_DIR,
      "upstream/docker-compose.yml",
      "../../etc/apps",
    );
    expect(result).toBe("./../../etc/apps/myapp/upstream/config");
  });

  it("appsRelPath with multi-level relative prefix is reflected verbatim", () => {
    // e.g. rendersDir deep in hierarchy → many ../ segments
    const result = rewriteRelativePath(
      "./volume/data",
      "jellyfin",
      APPS_DIR,
      undefined,
      "../../../../etc/apps",
    );
    expect(result).toBe("./../../../../etc/apps/jellyfin/volume/data");
  });

  it("appsRelPath with upstream dir and nested path combines all segments", () => {
    const result = rewriteRelativePath(
      "./db/data",
      "pg",
      APPS_DIR,
      "pg-upstream/compose.yml",
      "../apps",
    );
    expect(result).toBe("./../apps/pg/pg-upstream/db/data");
  });
});
