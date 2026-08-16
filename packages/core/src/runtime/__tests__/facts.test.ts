/**
 * Tests for runtime facts detection module.
 *
 * Strategy: we cannot reliably mock execSync in Vitest without heavy
 * vi.mock() gymnastics, so instead we test:
 *   1. The detectRuntimeFacts() function signature and return shape.
 *   2. That all returned values pass RuntimeFactsSchema validation.
 *   3. Edge-case behavior for operator ID persistence.
 *
 * We DON'T assert specific GPU/Docker values because those depend on the
 * host running the tests (CI has no nvidia-smi, dev may or may not).
 * The GPU trait tests in traits/definitions/__tests__/gpu.test.ts cover
 * the compile-time behavior with injected mock facts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRuntimeFacts } from "../facts.js";
import { RuntimeFactsSchema } from "../../schemas/runtime-facts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpStateDir(): string {
  const dir = join(tmpdir(), `appbay-facts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectRuntimeFacts", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tmpStateDir();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns an object that passes RuntimeFactsSchema", () => {
    const facts = detectRuntimeFacts({ stateDir });
    const result = RuntimeFactsSchema.safeParse(facts);
    expect(result.success, `Schema validation failed: ${JSON.stringify(result.error)}`).toBe(true);
  });

  it("returns gpu.available as a boolean", () => {
    const facts = detectRuntimeFacts({ stateDir });
    expect(typeof facts.gpu.available).toBe("boolean");
  });

  it("returns gpu.cdiSupported as a boolean", () => {
    const facts = detectRuntimeFacts({ stateDir });
    expect(typeof facts.gpu.cdiSupported).toBe("boolean");
  });

  it("returns docker.version as a string", () => {
    const facts = detectRuntimeFacts({ stateDir });
    expect(typeof facts.docker.version).toBe("string");
    expect(facts.docker.version.length).toBeGreaterThan(0);
  });

  it("returns docker.socketPath as a non-empty string", () => {
    const facts = detectRuntimeFacts({ stateDir });
    expect(typeof facts.docker.socketPath).toBe("string");
    expect(facts.docker.socketPath.length).toBeGreaterThan(0);
  });

  it("returns os.platform as a non-empty string", () => {
    const facts = detectRuntimeFacts({ stateDir });
    expect(typeof facts.os.platform).toBe("string");
    expect(facts.os.platform.length).toBeGreaterThan(0);
  });

  it("returns os.arch as a non-empty string", () => {
    const facts = detectRuntimeFacts({ stateDir });
    expect(typeof facts.os.arch).toBe("string");
    expect(facts.os.arch.length).toBeGreaterThan(0);
  });

  it("returns non-negative disk values", () => {
    const facts = detectRuntimeFacts({ stateDir });
    expect(facts.disk.availableGb).toBeGreaterThanOrEqual(0);
    expect(facts.disk.totalGb).toBeGreaterThanOrEqual(0);
  });

  it("generates and persists operator ID on first call", () => {
    const facts = detectRuntimeFacts({ stateDir });
    expect(facts.operatorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    // ID file should exist
    const idFile = join(stateDir, "operator-id");
    expect(existsSync(idFile)).toBe(true);
    expect(readFileSync(idFile, "utf-8").trim()).toBe(facts.operatorId);
  });

  it("reuses persisted operator ID on subsequent calls", () => {
    const first = detectRuntimeFacts({ stateDir });
    const second = detectRuntimeFacts({ stateDir });
    expect(first.operatorId).toBe(second.operatorId);
  });

  it("uses diskPath option for disk reporting when provided", () => {
    // Use a known temp path — just verifying it doesn't throw
    const facts = detectRuntimeFacts({ stateDir, diskPath: tmpdir() });
    expect(facts.disk.totalGb).toBeGreaterThan(0);
  });

  // ── resolveOperatorId: empty operator-id file ──────────────────────────────
  // Branch: existsSync returns true, readFileSync returns "", id.length === 0
  // → falls through to generate a new UUID.

  it("generates a new operator ID when operator-id file exists but is empty", () => {
    const { writeFileSync } = require("node:fs");
    const idFile = join(stateDir, "operator-id");
    writeFileSync(idFile, "", "utf-8"); // create the file with no content

    const facts = detectRuntimeFacts({ stateDir });

    // Should still return a valid UUID, not an empty string
    expect(facts.operatorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The empty file should now have been overwritten with the new ID
    const { readFileSync } = require("node:fs");
    expect(readFileSync(idFile, "utf-8").trim()).toBe(facts.operatorId);
  });

  // ── resolveOperatorId: operator-id is a directory (EISDIR) ────────────────
  // Branch: existsSync returns true, readFileSync throws EISDIR → catch →
  // generate new UUID, writeFileSync also throws EISDIR → inner catch →
  // return ephemeral UUID (not persisted).

  it("returns an ephemeral operator ID when operator-id path is a directory", () => {
    const { mkdirSync } = require("node:fs");
    const idFile = join(stateDir, "operator-id");
    mkdirSync(idFile); // create a DIRECTORY at the operator-id path

    const facts = detectRuntimeFacts({ stateDir });

    // Should still return a valid UUID even though it can't be persisted
    expect(facts.operatorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // ── detectDisk: catch block for unreachable/invalid diskPath ──────────────
  // Branch: statfsSync throws → catch returns { availableGb: 0, totalGb: 0 }.

  it("returns zero disk values when diskPath does not exist", () => {
    const nonExistentPath = join(stateDir, "does-not-exist");
    const facts = detectRuntimeFacts({ stateDir, diskPath: nonExistentPath });

    expect(facts.disk.availableGb).toBe(0);
    expect(facts.disk.totalGb).toBe(0);
  });
});
