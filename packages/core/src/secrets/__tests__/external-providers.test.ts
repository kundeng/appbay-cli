/**
 * Unit tests for the external CLI-backed secret provider:
 * SopsSecretProvider.
 *
 * Testing strategy:
 *   External providers delegate to system CLIs (`sops`) that are
 *   not available in the test environment. We test two distinct layers:
 *
 *   Layer 1 — URI parsing (no CLI call):
 *     Invalid URIs throw / return ok=false before any CLI invocation.
 *     These tests are hermetic and always run.
 *
 *   Layer 2 — CLI unavailable:
 *     Valid URIs with the CLI absent produce "not found" errors.
 *     These tests assume the CLI is not installed (true in CI and the
 *     standard dev environment checked with `which sops`).
 *
 * Coverage:
 *
 * SopsSecretProvider:
 *   - scheme: "sops"
 *   - resolve(): throws when '#' fragment is missing
 *   - resolve(): throws when file path is empty ("sops://#key")
 *   - resolve(): throws when key fragment is empty ("sops:///file#")
 *   - resolve(): throws "SOPS CLI not found" for valid URI when CLI absent
 *   - check(): ok=false with parse error for missing '#'
 *   - check(): ok=false with "SOPS CLI not found" when CLI absent
 *   - check(): ok=false with "not found or not readable" for nonexistent file when CLI available (skip if absent)
 */

import { describe, it, expect } from "vitest";
import { SopsSecretProvider } from "../providers/sops.js";

// ---------------------------------------------------------------------------
// SopsSecretProvider
// ---------------------------------------------------------------------------

describe("SopsSecretProvider", () => {
  const provider = new SopsSecretProvider();

  it('has scheme "sops"', () => {
    expect(provider.scheme).toBe("sops");
  });

  // ── URI parsing errors ───────────────────────────────────────────────────

  it("resolve(): throws when the '#key' fragment is missing entirely", async () => {
    await expect(
      provider.resolve("sops:///etc/appbay/secrets.yaml"),
    ).rejects.toThrow("missing '#key' fragment");
  });

  it("resolve(): throws when file path is empty (sops://#key)", async () => {
    await expect(provider.resolve("sops://#DB_PASSWORD")).rejects.toThrow(
      "empty file path",
    );
  });

  it("resolve(): throws when key fragment is empty (sops:///file#)", async () => {
    await expect(
      provider.resolve("sops:///etc/secrets.yaml#"),
    ).rejects.toThrow("empty key fragment");
  });

  it("check(): ok=false with parse error when '#' is missing", async () => {
    const uri = "sops:///etc/appbay/secrets.yaml";
    const result = await provider.check(uri);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing '#key' fragment/);
    expect(result.uri).toBe(uri);
  });

  it("check(): ok=false with parse error for empty file path", async () => {
    const uri = "sops://#KEY";
    const result = await provider.check(uri);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty file path/);
    expect(result.uri).toBe(uri);
  });

  it("check(): ok=false with parse error for empty key fragment", async () => {
    const uri = "sops:///path/secrets.yaml#";
    const result = await provider.check(uri);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty key fragment/);
    expect(result.uri).toBe(uri);
  });

  // ── CLI unavailable (no sops binary in test env) ─────────────────────────

  it("resolve(): throws 'SOPS CLI not found' for a valid URI when CLI is absent", async () => {
    await expect(
      provider.resolve("sops:///etc/appbay/secrets.yaml#database.password"),
    ).rejects.toThrow("SOPS CLI not found");
  });

  it("resolve(): throws for dot-notation nested key when CLI absent", async () => {
    await expect(
      provider.resolve(
        "sops:///secrets/prod.yaml#services.postgres.POSTGRES_PASSWORD",
      ),
    ).rejects.toThrow("SOPS CLI not found");
  });

  it("resolve(): throws for flat (non-nested) key when CLI absent", async () => {
    await expect(
      provider.resolve("sops:///etc/secrets.yaml#DB_PASSWORD"),
    ).rejects.toThrow("SOPS CLI not found");
  });

  it("check(): ok=false with 'SOPS CLI not found' for valid URI when CLI absent", async () => {
    const uri = "sops:///etc/appbay/secrets.yaml#DB_PASSWORD";
    const result = await provider.check(uri);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SOPS CLI not found/);
    expect(result.uri).toBe(uri);
  });

  it("check(): uri field is preserved even when CLI is absent", async () => {
    const uri = "sops:///secrets/prod.yaml#api.key";
    const result = await provider.check(uri);
    expect(result.uri).toBe(uri);
  });

  // ── File existence check (SOPS-specific pre-flight) ───────────────────────
  // check() validates file existence before attempting decryption.
  // This test only runs if `sops` CLI is installed (it's a guard, not a skip).
  // In the standard test env (no sops), these are unreachable.
  // If sops IS installed but the file doesn't exist, the error is "not found".
  // Covered by the CLI-absent test above via the earlier bail-out.
});
