/**
 * Carrying legacy control-plane accounts to the edge — RFC-001 §1.5 (spec task 5.4).
 *
 * ⭐ THIS MIGRATION EXISTS SO AN UPGRADE DOES NOT LOCK THE OPERATOR OUT, so the tests are
 * about the ways it could quietly fail to do that: an account that does not arrive, an account
 * that arrives without the role it needs to sign in, a disabled account that comes back to
 * life, and a legacy file archived while something was still unresolved.
 *
 * The store is stubbed rather than real because `EdgeIdentityStore` hashes by shelling out to
 * the Caddy image. Hashing is not what is under test here; who gets created, with which role,
 * and what the file does afterwards is.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_CONTROL_PLANE_REL,
  importControlPlaneAccounts,
} from "../control-plane-import.js";
import type { EdgeIdentityStore } from "../edge-identity-service.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "appbay-cp-import-"));
});

async function writeLegacy(yaml: string): Promise<string> {
  const path = join(home, LEGACY_CONTROL_PLANE_REL);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, yaml);
  return path;
}

interface Created {
  username: string;
  email: string;
  password: string;
  roles?: string[];
}

/** A stub with the two methods the import touches. */
function stubStore(existingUsernames: string[] = []) {
  const created: Created[] = [];
  const store = {
    read: async () => ({ users: existingUsernames.map((username) => ({ username })) }),
    create: async (input: Created) => {
      created.push(input);
      return input;
    },
  } as unknown as EdgeIdentityStore;
  return { store, created };
}

describe("no legacy file", () => {
  it("reports nothing found rather than failing", async () => {
    const { store } = stubStore();
    expect(await importControlPlaneAccounts(home, store)).toEqual({
      found: false,
      imported: [],
      skipped: [],
      archivedTo: null,
    });
  });
});

describe("what comes across", () => {
  it("imports each active account with a generated password", async () => {
    await writeLegacy(`users:
  - username: alice
    status: active
  - username: bob
    status: active
`);
    const { store, created } = stubStore();
    const report = await importControlPlaneAccounts(home, store);

    expect(report.imported.map((a) => a.username)).toEqual(["alice", "bob"]);
    expect(created).toHaveLength(2);
    // 🚨 The passwords must be NEW and distinct. The old ones were scrypt hashes and the edge
    // stores bcrypt, so nothing could be carried over — and reusing one value for everybody
    // would hand every imported operator each other's credential.
    const passwords = report.imported.map((a) => a.password);
    expect(new Set(passwords).size).toBe(2);
    for (const p of passwords) expect(p.length).toBeGreaterThanOrEqual(24);
  });

  it("🚨 grants authp/admin, or the account cannot reach the control plane", async () => {
    // The control plane's edge route admits authp/admin only. Importing these as ordinary
    // users would move every account across and leave none of them able to sign in — a
    // migration that reports success and strands the operator anyway.
    await writeLegacy("users:\n  - username: alice\n    status: active\n");
    const { store, created } = stubStore();
    await importControlPlaneAccounts(home, store);
    expect(created[0]?.roles).toEqual(["authp/admin"]);
  });

  it("archives the legacy file once every account is dealt with", async () => {
    const path = await writeLegacy("users:\n  - username: alice\n    status: active\n");
    const { store } = stubStore();
    const report = await importControlPlaneAccounts(home, store);
    expect(existsSync(path)).toBe(false);
    expect(report.archivedTo).toBe(`${path}.imported`);
    expect(await readFile(`${path}.imported`, "utf-8")).toContain("alice");
  });

  it("is idempotent — a second run finds nothing", async () => {
    await writeLegacy("users:\n  - username: alice\n    status: active\n");
    const { store } = stubStore();
    await importControlPlaneAccounts(home, store);
    const second = await importControlPlaneAccounts(home, stubStore().store);
    expect(second.found).toBe(false);
  });
});

describe("what does not come across", () => {
  it("🚨 does NOT re-enable a disabled account", async () => {
    // The edge store has no disabled state, so importing one would restore access somebody
    // deliberately removed — the migration silently undoing a security decision.
    await writeLegacy(`users:
  - username: alice
    status: active
  - username: mallory
    status: disabled
`);
    const { store, created } = stubStore();
    const report = await importControlPlaneAccounts(home, store);

    expect(created.map((c) => c.username)).toEqual(["alice"]);
    expect(report.skipped).toContainEqual({
      username: "mallory",
      reason: 'status is "disabled", not active',
    });
  });

  it("does not clobber a username that already exists at the edge", async () => {
    await writeLegacy("users:\n  - username: alice\n    status: active\n");
    const { store, created } = stubStore(["alice"]);
    const report = await importControlPlaneAccounts(home, store);
    expect(created).toHaveLength(0);
    expect(report.skipped).toContainEqual({
      username: "alice",
      reason: "already exists at the edge",
    });
  });

  it("🚨 keeps the legacy file when a record could not even be named", async () => {
    // Archiving it would destroy the only record of an account nobody can now identify.
    const path = await writeLegacy("users:\n  - username: alice\n    status: active\n  - status: active\n");
    const { store } = stubStore();
    const report = await importControlPlaneAccounts(home, store);
    expect(report.imported.map((a) => a.username)).toEqual(["alice"]);
    expect(report.skipped).toContainEqual({
      username: "(unnamed)",
      reason: "the record has no username",
    });
    expect(report.archivedTo).toBeNull();
    expect(existsSync(path)).toBe(true);
  });

  it("survives a file with no users key at all", async () => {
    await writeLegacy("version: 1\n");
    const { store } = stubStore();
    const report = await importControlPlaneAccounts(home, store);
    expect(report).toMatchObject({ found: true, imported: [], skipped: [] });
  });

  it("treats an account with no status as active — the field was optional", async () => {
    await writeLegacy("users:\n  - username: alice\n");
    const { store, created } = stubStore();
    await importControlPlaneAccounts(home, store);
    expect(created.map((c) => c.username)).toEqual(["alice"]);
  });
});
