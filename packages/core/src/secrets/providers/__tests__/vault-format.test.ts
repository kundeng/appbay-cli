/**
 * Vault file format v1 → v2 — RFC-001 §2.5.
 *
 * ⭐ THE TEST THAT MATTERS IS "AN EXISTING VAULT STILL OPENS". Every vault written before this
 * change is v1, and dropping that path does not fail loudly: it fails as "Wrong vault password"
 * on an intact file. There is no migration command that could rescue it either, because by then
 * the operator cannot read the file to migrate it.
 *
 * So the v1 fixtures here are built by ENCRYPTING THE v1 WAY with node:crypto directly, not by
 * calling a v1 code path that no longer exists. A fixture produced by the code under test would
 * only prove the code agrees with itself.
 */

import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Vault } from "../vault.js";

const PASSWORD = "correct-horse-battery-staple";

let dir: string;
let vaultPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "appbay-vault-format-"));
  vaultPath = join(dir, "vault.enc");
});

/**
 * Write a v1 vault file the way appbay wrote them before §2.5: the constant salt, and
 * `IV(12) + tag(16) + ciphertext` with no header at all.
 */
function writeV1Vault(entries: Record<string, string>, password = PASSWORD): void {
  const key = scryptSync(password, "appbay-vault-v1", 32, { N: 16384 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(entries), "utf8"),
    cipher.final(),
  ]);
  writeFileSync(vaultPath, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
}

const V2_MAGIC = Buffer.from("APPBAYV2", "ascii");

function isV2(path: string): boolean {
  const raw = readFileSync(path);
  return raw.subarray(0, 8).equals(V2_MAGIC);
}

describe("an existing v1 vault keeps working", () => {
  it("reads entries written by the old format", () => {
    writeV1Vault({ "default/API_KEY": "sk-secret", "litellm/DB_PASSWORD": "hunter2" });
    const vault = new Vault(vaultPath, PASSWORD);
    expect(vault.get("API_KEY")).toBe("sk-secret");
    expect(vault.get("DB_PASSWORD", "litellm")).toBe("hunter2");
  });

  it("🚨 does NOT rewrite the file just because it was read", () => {
    // Reading must never mutate the one file whose corruption is unrecoverable.
    writeV1Vault({ "default/API_KEY": "sk-secret" });
    const before = readFileSync(vaultPath);
    new Vault(vaultPath, PASSWORD);
    expect(readFileSync(vaultPath).equals(before)).toBe(true);
    expect(isV2(vaultPath)).toBe(false);
  });

  it("upgrades to v2 on the first write, keeping every existing entry", () => {
    writeV1Vault({ "default/OLD_ONE": "kept", "app/OLD_TWO": "also-kept" });
    const vault = new Vault(vaultPath, PASSWORD);
    vault.set("NEW_ONE", "added");

    expect(isV2(vaultPath)).toBe(true);

    const reopened = new Vault(vaultPath, PASSWORD);
    expect(reopened.get("OLD_ONE")).toBe("kept");
    expect(reopened.get("OLD_TWO", "app")).toBe("also-kept");
    expect(reopened.get("NEW_ONE")).toBe("added");
  });

  it("upgrades on delete too, not only on set", () => {
    writeV1Vault({ "default/A": "1", "default/B": "2" });
    const vault = new Vault(vaultPath, PASSWORD);
    expect(vault.delete("A")).toBe(true);
    expect(isV2(vaultPath)).toBe(true);
    expect(new Vault(vaultPath, PASSWORD).get("B")).toBe("2");
  });

  it("still rejects the wrong password on a v1 file", () => {
    writeV1Vault({ "default/A": "1" });
    expect(() => new Vault(vaultPath, "wrong-password")).toThrow(/Wrong vault password/);
  });
});

describe("v2 is per-vault salted — the defect §2.5 exists to fix", () => {
  it("writes a fresh vault in v2", () => {
    const vault = new Vault(vaultPath, PASSWORD);
    vault.set("KEY", "value");
    expect(isV2(vaultPath)).toBe(true);
    expect(new Vault(vaultPath, PASSWORD).get("KEY")).toBe("value");
  });

  it("🚨 two vaults with the SAME password no longer share a key", () => {
    // The whole point. Under v1 the key was a pure function of the password, so every appbay
    // vault shared one key space and ONE scrypt precomputation for a candidate password
    // attacked all of them. A stolen v2 file still carries its own salt and is still openable
    // with its password — no self-describing format can avoid that — but the work is per file.
    const otherPath = join(dir, "other.enc");
    const a = new Vault(vaultPath, PASSWORD);
    a.set("K", "same-plaintext");
    const b = new Vault(otherPath, PASSWORD);
    b.set("K", "same-plaintext");

    const saltA = readFileSync(vaultPath).subarray(9, 25);
    const saltB = readFileSync(otherPath).subarray(9, 25);
    expect(saltA.equals(saltB)).toBe(false);
  });

  it("keeps its salt across writes, so it stays readable", () => {
    const vault = new Vault(vaultPath, PASSWORD);
    vault.set("ONE", "1");
    const saltAfterFirst = readFileSync(vaultPath).subarray(9, 25);
    vault.set("TWO", "2");
    expect(readFileSync(vaultPath).subarray(9, 25).equals(saltAfterFirst)).toBe(true);

    const reopened = new Vault(vaultPath, PASSWORD);
    expect(reopened.get("ONE")).toBe("1");
    expect(reopened.get("TWO")).toBe("2");
  });

  it("rejects the wrong password on a v2 file", () => {
    new Vault(vaultPath, PASSWORD).set("K", "v");
    expect(() => new Vault(vaultPath, "nope")).toThrow(/Wrong vault password/);
  });
});

describe("an entry key the writer never wrote", () => {
  /** Write a v2 vault with an arbitrary payload, bypassing `vaultEntryKey`. */
  function writeRawVault(entries: Record<string, string>): void {
    const salt = randomBytes(16);
    const key = scryptSync(PASSWORD, salt, 32, { N: 16384 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(entries), "utf8"),
      cipher.final(),
    ]);
    writeFileSync(
      vaultPath,
      Buffer.concat([V2_MAGIC, Buffer.from([2]), salt, iv, cipher.getAuthTag(), ciphertext]),
    );
  }

  it("🚨 reports an unslashed key verbatim, not the key minus its last character", () => {
    // `lastIndexOf("/")` returns -1, so the old code produced `scope = k.slice(0, -1)`:
    // "NOSLASH" was listed as scope "NOSLAS", key "NOSLASH". An entry that enumerates and
    // then reads back as null, naming a scope that does not exist anywhere.
    writeRawVault({ NOSLASH: "the-value", "default/OK": "fine" });
    const listed = new Vault(vaultPath, PASSWORD).listAll();
    expect(listed).toContainEqual({ scope: "default", key: "NOSLASH" });
    expect(listed.map((e) => e.scope)).not.toContain("NOSLAS");
  });

  it("still lists the well-formed entries alongside it", () => {
    writeRawVault({ NOSLASH: "the-value", "default/OK": "fine" });
    const vault = new Vault(vaultPath, PASSWORD);
    expect(vault.listAll()).toContainEqual({ scope: "default", key: "OK" });
    expect(vault.get("OK")).toBe("fine");
  });
});

describe("corrupt and future files fail legibly", () => {
  it("names a FUTURE format version instead of blaming the password", () => {
    // Reading a newer file with these offsets would produce "Wrong vault password" on a file
    // that is perfectly fine — sending the operator to rotate a credential that works.
    const body = Buffer.alloc(60);
    writeFileSync(vaultPath, Buffer.concat([V2_MAGIC, Buffer.from([99]), body]));
    expect(() => new Vault(vaultPath, PASSWORD)).toThrow(/format version 99/);
    expect(() => new Vault(vaultPath, PASSWORD)).toThrow(/Upgrade appbay/);
  });

  it("reports a truncated v2 header as corruption", () => {
    writeFileSync(vaultPath, Buffer.concat([V2_MAGIC, Buffer.from([2]), Buffer.alloc(4)]));
    expect(() => new Vault(vaultPath, PASSWORD)).toThrow(/corrupted/);
  });

  it("reports a too-short v1 file as corruption", () => {
    writeFileSync(vaultPath, Buffer.alloc(10));
    expect(() => new Vault(vaultPath, PASSWORD)).toThrow(/corrupted/);
  });

  it("treats a missing file as an empty vault, not an error", () => {
    const vault = new Vault(join(dir, "absent.enc"), PASSWORD);
    expect(vault.listAll()).toEqual([]);
  });
});
