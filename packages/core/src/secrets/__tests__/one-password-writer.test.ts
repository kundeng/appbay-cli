/**
 * RFC-001 §2.2's actual invariant: ONE place decides where the master password lives.
 *
 * ⭐ WHY A SOURCE SCAN AND NOT A BEHAVIOUR TEST. §2.2 consolidated four password resolvers into
 * one, and the consolidation shipped with two writers left behind. Both were found by sampling,
 * one at a time, and the second — `rotateVaultPassword` — had made the vault PERMANENTLY
 * UNREADABLE while reporting "re-encrypted N secret(s)". A behaviour test proves one call site
 * is right; this proves no other call site exists.
 *
 * The rule: only `master-password.ts` may construct a legacy password path. It needs them to
 * READ, so an installation predating the consolidation keeps opening. Anywhere else, building
 * one of those paths means writing a password the resolver will not prefer — which is the exact
 * shape of the bug this file exists to prevent recurring.
 *
 * ⚠️ Matches the `join("etc", "…")` construction, not the words. Comments legitimately discuss
 * `etc/vault-password` while explaining why nothing writes there.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");
/** The one module allowed to name the legacy paths, because it reads them. */
const OWNER = join("secrets", "master-password.ts");

/** Building a legacy password path in code — not a mention of one in prose. */
const LEGACY_PATH_CONSTRUCTION = /join\(\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?["']etc["']\s*,\s*["'](?:vault|kdbx)-password["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__tests__" || entry === "node_modules" ? [] : sourceFiles(full);
    }
    return entry.endsWith(".ts") ? [full] : [];
  });
}

describe("only one module decides where the master password lives", () => {
  it("🚨 nothing outside master-password.ts constructs a legacy password path", () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !relative(SRC, f).endsWith(OWNER))
      .filter((f) => LEGACY_PATH_CONSTRUCTION.test(readFileSync(f, "utf-8")))
      .map((f) => relative(SRC, f));

    expect(
      offenders,
      `these build an etc/{vault,kdbx}-password path. Writing there stores a password the ` +
        `resolver will not prefer — it reads var/lib/secrets/master-password first — so the ` +
        `store ends up encrypted with a password nothing returns: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("master-password.ts itself still names them, because it READS them", () => {
    // If this fails the legacy tiers are gone, and every pre-§2.2 installation stops opening.
    const owner = readFileSync(join(SRC, OWNER), "utf-8");
    expect(LEGACY_PATH_CONSTRUCTION.test(owner)).toBe(true);
  });

  it("the scan actually sees the tree — not an empty list", () => {
    // Without this every assertion above passes vacuously if the walk breaks.
    const files = sourceFiles(SRC).map((f) => relative(SRC, f));
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain(join("services", "vault-service.ts"));
    expect(files).toContain(OWNER);
  });

  it("the matcher rejects what it is meant to, and spares prose", () => {
    // Pins the regex: a comment mentioning the path must not trip it, and a real construction
    // must. Otherwise the first test could pass because the pattern stopped matching anything.
    expect(LEGACY_PATH_CONSTRUCTION.test('join("etc", "vault-password")')).toBe(true);
    expect(LEGACY_PATH_CONSTRUCTION.test('join(appbayHome, "etc", "kdbx-password")')).toBe(true);
    expect(LEGACY_PATH_CONSTRUCTION.test("// see `etc/vault-password` for the legacy tier")).toBe(false);
    expect(LEGACY_PATH_CONSTRUCTION.test('join(appbayHome, MASTER_PASSWORD_REL)')).toBe(false);
  });
});
