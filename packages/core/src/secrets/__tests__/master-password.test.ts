/**
 * The single master password resolver — RFC-001 §2.2.
 *
 * Replaces four resolvers in two duplicated pairs. The cases that matter are the ones the
 * consolidation creates rather than the happy path: an existing install must keep working
 * through the move, and two legacy passwords that DISAGREE must not be silently collapsed.
 */

import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MASTER_PASSWORD_REL,
  hasMasterPassword,
  persistMasterPassword,
  resolveMasterPassword,
} from "../master-password.js";

const ENV_KEYS = [
  "APPBAY_MASTER_PASSWORD",
  "APPBAY_VAULT_PASSWORD",
  "APPBAY_KEEPASS_PASSWORD",
] as const;

let home: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "appbay-master-pw-"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function writeLegacy(name: string, value: string): Promise<void> {
  await mkdir(join(home, "etc"), { recursive: true });
  await writeFile(join(home, "etc", name), value, { mode: 0o600 });
}

describe("resolution order", () => {
  it("prefers APPBAY_MASTER_PASSWORD above everything", async () => {
    process.env.APPBAY_MASTER_PASSWORD = "from-env";
    persistMasterPassword(home, "from-file");
    await writeLegacy("vault-password", "legacy");
    expect(resolveMasterPassword(home)).toBe("from-env");
  });

  it("then the §2 file", async () => {
    persistMasterPassword(home, "from-file");
    await writeLegacy("vault-password", "legacy");
    expect(resolveMasterPassword(home)).toBe("from-file");
  });

  it("then a legacy env var", async () => {
    process.env.APPBAY_VAULT_PASSWORD = "legacy-env";
    await writeLegacy("vault-password", "legacy-file");
    expect(resolveMasterPassword(home)).toBe("legacy-env");
  });

  it("then a legacy file — an existing install survives the move", async () => {
    // The migration case: nothing has been written at the new location yet, and the
    // installation must keep opening its vault.
    await writeLegacy("vault-password", "legacy-file");
    expect(resolveMasterPassword(home)).toBe("legacy-file");
  });

  it("reads a kdbx-only install too", async () => {
    await writeLegacy("kdbx-password", "kdbx-only");
    expect(resolveMasterPassword(home)).toBe("kdbx-only");
  });

  it("ignores a blank password file rather than returning an empty string", async () => {
    await writeLegacy("vault-password", "   \n");
    expect(() => resolveMasterPassword(home)).toThrow(/No master password/);
  });
});

describe("two legacy passwords that disagree", () => {
  // 🚨 The hazard §2.2 creates and the RFC does not mention. `initVault` generated one
  // password and `initKdbx` generated its OWN randomBytes(24) when no env var was set, so an
  // install that used both backends holds two unrelated credentials. Collapsing to one
  // silently leaves the other store readable by nothing — the data is intact and nothing can
  // open it, which is the worst shape a secrets bug takes.
  it("refuses to guess which is the master", async () => {
    await writeLegacy("vault-password", "opens-vault-enc");
    await writeLegacy("kdbx-password", "opens-secrets-kdbx");

    expect(() => resolveMasterPassword(home)).toThrow(/refusing to guess/i);
    expect(() => resolveMasterPassword(home)).toThrow(/vault-password/);
    expect(() => resolveMasterPassword(home)).toThrow(/kdbx-password/);
  });

  it("is happy when they agree", async () => {
    await writeLegacy("vault-password", "same");
    await writeLegacy("kdbx-password", "same");
    expect(resolveMasterPassword(home)).toBe("same");
  });

  it("does not block once the operator has chosen — the §2 file wins", async () => {
    await writeLegacy("vault-password", "one");
    await writeLegacy("kdbx-password", "two");
    persistMasterPassword(home, "chosen");
    expect(resolveMasterPassword(home)).toBe("chosen");
  });
});

describe("generation", () => {
  it("does not write on a plain read", () => {
    expect(() => resolveMasterPassword(home)).toThrow();
    expect(hasMasterPassword(home)).toBe(false);
  });

  it("generates and persists only when asked, and is stable afterwards", () => {
    const first = resolveMasterPassword(home, { generate: true });
    expect(first).toHaveLength(32); // 24 random bytes, base64url
    expect(hasMasterPassword(home)).toBe(true);
    expect(resolveMasterPassword(home)).toBe(first);
  });

  it("writes 0600 at create time, not after", async () => {
    // The file is the root of the encryption tree; a write-then-chmod leaves a window at the
    // umask's permissions.
    persistMasterPassword(home, "secret");
    const path = join(home, MASTER_PASSWORD_REL);
    const { mode } = await import("node:fs/promises").then((fs) => fs.stat(path));
    expect(mode & 0o777).toBe(0o600);
    expect((await readFile(path, "utf-8")).trim()).toBe("secret");
  });

  it("creates var/lib/secrets when it does not exist", async () => {
    persistMasterPassword(home, "x");
    await expect(chmod(join(home, "var", "lib", "secrets"), 0o700)).resolves.toBeUndefined();
  });
});
