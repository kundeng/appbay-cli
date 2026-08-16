import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EdgeIdentityStore } from "../edge-identity-service.js";

const HASH_A = "$2a$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "$2a$10$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const homes: string[] = [];

async function storeWithEmptyDatabase() {
  const home = await mkdtemp(join(tmpdir(), "appbay-edge-identities-"));
  homes.push(home);
  const store = new EdgeIdentityStore(home, (password) => password === "new" ? HASH_B : HASH_A);
  await store.write({
    version: "1.0.0",
    policy: {},
    revision: 0,
    last_modified: "0001-01-01T00:00:00Z",
    loaded_at: "0001-01-01T00:00:00Z",
    users: [],
  });
  return store;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("EdgeIdentityStore", () => {
  it("creates a typed local identity in a mode-0600 filesystem store", async () => {
    const store = await storeWithEmptyDatabase();
    await store.create({ username: "alice", email: "alice@example.test", password: "old", roles: ["user"] });

    const document = await store.read();
    expect(document.users[0]?.username).toBe("alice");
    expect(document.users[0]?.roles).toEqual([{ organization: "authp", name: "user" }]);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  it("replaces all old password hashes during reset", async () => {
    const store = await storeWithEmptyDatabase();
    await store.create({ username: "alice", email: "alice@example.test", password: "old" });
    await store.resetPassword("alice", "new");

    const user = (await store.read()).users[0]!;
    expect(user.passwords).toHaveLength(1);
    expect(user.passwords[0]?.hash).toBe(HASH_B);
    expect(user.passwords.some((password) => password.hash === HASH_A)).toBe(false);
  });
});
