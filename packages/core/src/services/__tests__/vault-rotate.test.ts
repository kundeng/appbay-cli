/**
 * Rotating and repairing the vault password — RFC-001 §2.2.
 *
 * 🚨 THE BUG THESE PIN LOST SECRETS AND REPORTED SUCCESS. `rotateVaultPassword` re-encrypted
 * the vault with a new password and wrote that password to the LEGACY `etc/vault-password`,
 * while `resolveMasterPassword` reads `var/lib/secrets/master-password` FIRST. So on any
 * installation created after §2.2, rotation printed "re-encrypted N secret(s)" and the very
 * next read answered "Wrong vault password" — permanently. The data was intact on disk and
 * nothing could open it.
 *
 * ⚠️ It is the same regression `initKdbx` had, and it was missed for the same reason: §2.2
 * fixed the two INIT paths and never looked at rotate/repair. So the assertion that matters is
 * not "the file exists" but "the resolver can still open the vault" — the only thing that
 * distinguishes the fixed code from the broken code, since both wrote *a* password file.
 */

import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MASTER_PASSWORD_REL, resolveMasterPassword } from "../../secrets/master-password.js";
import { Vault } from "../../secrets/providers/vault.js";
import { initVault, repairVaultPasswordFile, rotateVaultPassword, setSecret } from "../vault-service.js";

const ENV = ["APPBAY_MASTER_PASSWORD", "APPBAY_VAULT_PASSWORD", "APPBAY_KEEPASS_PASSWORD"] as const;

let home: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "appbay-vault-rotate-"));
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(home, { recursive: true, force: true });
});

const vaultPath = () => join(home, "var", "lib", "vault.enc");
const legacyPath = () => join(home, "etc", "vault-password");
const masterPath = () => join(home, MASTER_PASSWORD_REL);

/** Open the vault the way every command does — through the resolver. */
function openAsCallersDo(): Vault {
  return new Vault(vaultPath(), resolveMasterPassword(home));
}

describe("rotateVaultPassword", () => {
  beforeEach(() => {
    initVault(home);
    setSecret(home, "MY_KEY", "the-secret-value");
  });

  it("🚨 the vault still opens afterwards — the whole bug", () => {
    rotateVaultPassword(home);
    expect(openAsCallersDo().get("MY_KEY")).toBe("the-secret-value");
  });

  it("writes the new password where the resolver looks FIRST", () => {
    rotateVaultPassword(home);
    expect(existsSync(masterPath())).toBe(true);
    // Writing only the legacy file is exactly what made the vault unopenable.
    expect(existsSync(legacyPath())).toBe(false);
  });

  it("the stored password is the one the vault was re-encrypted with", () => {
    rotateVaultPassword(home);
    return readFile(masterPath(), "utf-8").then((stored) => {
      // Constructing directly, not through the resolver, so this fails if the file holds a
      // stale value that merely happens to be resolvable some other way.
      expect(new Vault(vaultPath(), stored.trim()).get("MY_KEY")).toBe("the-secret-value");
    });
  });

  it("carries every entry across, in every scope", () => {
    // ⚠️ The scope travels INSIDE the key (`splitScopedKey`), not as a fourth argument.
    // Passing it separately silently stores under `default` — which is how this test first
    // failed, and a good reminder that the API's shape is not the obvious one.
    setSecret(home, "litellm/DB_PASSWORD", "hunter2");
    const result = rotateVaultPassword(home);
    expect(result.entries).toBe(2);
    const reopened = openAsCallersDo();
    expect(reopened.get("MY_KEY")).toBe("the-secret-value");
    expect(reopened.get("DB_PASSWORD", "litellm")).toBe("hunter2");
  });

  it("accepts an explicit password and reports it was not generated", () => {
    const result = rotateVaultPassword(home, "a-chosen-password");
    expect(result.generated).toBe(false);
    expect(new Vault(vaultPath(), "a-chosen-password").get("MY_KEY")).toBe("the-secret-value");
  });

  it("refuses when there is no vault, rather than creating an empty one", () => {
    const empty = join(home, "nothing");
    expect(() => rotateVaultPassword(empty)).toThrow(/not initialized/i);
  });
});

describe("a legacy installation, with only etc/vault-password", () => {
  beforeEach(async () => {
    initVault(home);
    setSecret(home, "OLD_KEY", "legacy-value");
    // Move the password to where a pre-§2.2 install kept it.
    await mkdir(join(home, "etc"), { recursive: true });
    await rename(masterPath(), legacyPath());
  });

  it("still reads before rotation — the fallback tier works", () => {
    expect(openAsCallersDo().get("OLD_KEY")).toBe("legacy-value");
  });

  it("🚨 rotation MIGRATES it, and the vault stays readable", () => {
    rotateVaultPassword(home);
    expect(existsSync(masterPath())).toBe(true);
    expect(openAsCallersDo().get("OLD_KEY")).toBe("legacy-value");
  });

  it("leaves the stale legacy file harmless rather than authoritative", () => {
    rotateVaultPassword(home);
    // It is tier 4; the tier-2 file just written outranks it. What must NOT happen is the
    // resolver preferring the stale one.
    return readFile(legacyPath(), "utf-8").then((stale) => {
      expect(resolveMasterPassword(home)).not.toBe(stale.trim());
      expect(openAsCallersDo().get("OLD_KEY")).toBe("legacy-value");
    });
  });
});

describe("repairVaultPasswordFile", () => {
  it("restores into the path the resolver reads, not the legacy one", async () => {
    initVault(home);
    setSecret(home, "K", "v");
    const password = await readFile(masterPath(), "utf-8");
    await rm(masterPath());
    process.env.APPBAY_MASTER_PASSWORD = password.trim();

    const { passwordPath } = repairVaultPasswordFile(home);
    expect(passwordPath).toBe(masterPath());

    delete process.env.APPBAY_MASTER_PASSWORD;
    expect(openAsCallersDo().get("K")).toBe("v");
  });
});
