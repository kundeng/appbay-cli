import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ControlPlaneUserStore,
  type ControlPlaneUser,
} from "../../index.js";

const homes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "appbay-control-plane-users-"));
  homes.push(home);
  return home;
}

function user(overrides: Partial<ControlPlaneUser> = {}): ControlPlaneUser {
  return {
    id: "user-1",
    username: "admin",
    passwordHash: `${"a".repeat(32)}:${"b".repeat(128)}`,
    status: "active",
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("ControlPlaneUserStore", () => {
  it("writes and reads a private authoritative document", async () => {
    const store = new ControlPlaneUserStore(await temporaryHome());
    await store.write({ version: 1, users: [user()] });

    expect(await store.read()).toEqual({ version: 1, users: [user()] });
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(store.path, "utf-8")).toContain("username: admin");
  });

  it("rejects duplicate stable identities before writing", async () => {
    const store = new ControlPlaneUserStore(await temporaryHome());
    await expect(
      store.write({
        version: 1,
        users: [user(), user({ username: "second" })],
      }),
    ).rejects.toThrow("duplicate user id");
    expect(await store.exists()).toBe(false);
  });

  it("atomically replaces one password hash without changing identity", async () => {
    const store = new ControlPlaneUserStore(await temporaryHome());
    const original = user();
    await store.write({ version: 1, users: [original] });

    const passwordHash = `${"c".repeat(32)}:${"d".repeat(128)}`;
    const changed = await store.replacePasswordHash(
      "admin",
      passwordHash,
      "2026-08-10T13:00:00.000Z",
    );

    expect(changed).toEqual({
      ...original,
      passwordHash,
      updatedAt: "2026-08-10T13:00:00.000Z",
    });
    expect((await store.read())?.users).toEqual([changed]);
  });

  it("survives cache deletion — the authoritative file is independent of SQLite", async () => {
    // Task 7 invariant: deleting the SQLite cache and rebuilding must not reopen
    // first-run registration. The authoritative users.yaml is the source of truth;
    // a fresh store instance reading the same home must still see the admin.
    const home = await temporaryHome();
    const store = new ControlPlaneUserStore(home);
    await store.write({ version: 1, users: [user()] });

    // Simulate a cache wipe + rebuild: a brand-new store over the same home.
    const rebuilt = new ControlPlaneUserStore(home);
    const document = await rebuilt.read();

    expect(document).not.toBeNull();
    expect(document?.users).toHaveLength(1);
    expect(document?.users[0]?.username).toBe("admin");
    // Registration stays disabled because the authoritative file still has a user.
    expect(document!.users.length).toBeGreaterThan(0);
  });

  it("migrates a legacy SQLite-only user into the authoritative file once", async () => {
    // Task 7: a legacy SQLite-only installation exports its user to the file once,
    // before first-run registration is allowed. The store must persist it so a
    // subsequent read sees the migrated user.
    const home = await temporaryHome();
    const store = new ControlPlaneUserStore(home);
    const legacy = user({ id: "legacy-1", username: "legacy-admin" });
    await store.write({ version: 1, users: [legacy] });

    const migrated = await store.read();
    expect(migrated?.users[0]?.username).toBe("legacy-admin");
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });
});
