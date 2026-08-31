/**
 * KeePass CRUD round-trip — RFC-001 §3.1.
 *
 * These paths had zero test coverage, which is how three defects survived in them:
 * `db-create --set-password` was sent one line where it prompts twice, `edit --password`
 * is not an option keepassxc-cli has, and both the master password and the stored secret
 * were composed into a `/bin/sh -c` argv. The first two are functional bugs that any
 * round-trip test would have caught on day one; this is that test.
 *
 * ⚠️ Requires a real `keepassxc-cli` on PATH. It is not mocked on purpose — a mock would
 * assert the argv shape this code builds, and the argv shape was never the thing that was
 * wrong. `edit --password` looked entirely plausible and the tool rejects it. Only the real
 * binary can tell us that.
 *
 * Verified against keepassxc-cli 2.6.6.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initKdbx,
  setKdbxSecret,
  getKdbxSecret,
  deleteKdbxSecret,
  listKdbxSecrets,
} from "../vault-service.js";

function keepassxcAvailable(): boolean {
  try {
    execFileSync("keepassxc-cli", ["--version"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const hasCli = keepassxcAvailable();

if (!hasCli) {
  // Loud, per the convention in 3d653bd: a skip is not a pass, and a silent skip is how a
  // suite comes to report green on a path nothing has executed.
  //
  // ⚠️ `console.warn` here is swallowed — vitest discards module-scope console output for a
  // file whose every test is skipped, so the warning that says "this was not verified" is
  // itself the thing that goes missing. Measured. Write to the real fd instead, and put the
  // reason in the suite name so it survives any reporter that prints skipped names.
  process.stderr.write(
    "\n🚨 SKIPPED: kdbx-crud.test.ts needs keepassxc-cli on PATH and it is not installed.\n" +
      "   The KeePass CRUD round trip was NOT verified by this run.\n" +
      "   Install it:  apt install keepassxc   (or: brew install keepassxc)\n\n",
  );
}

const suiteName = hasCli
  ? "KeePass CRUD round trip (real keepassxc-cli)"
  : "KeePass CRUD round trip — SKIPPED, keepassxc-cli not on PATH, NOT verified";

describe.skipIf(!hasCli)(suiteName, () => {
  async function freshHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "appbay-kdbx-"));
    await initKdbx(home, "master-pw");
    return home;
  }

  it("creates a database — the single-line db-create could not", async () => {
    const home = await mkdtemp(join(tmpdir(), "appbay-kdbx-"));
    const result = await initKdbx(home, "master-pw");
    expect(result.dbPath).toContain("secrets.kdbx");
    expect(result.generated).toBe(false);
  }, 30_000);

  it("stores and reads back a new entry", async () => {
    const home = await freshHome();
    await setKdbxSecret(home, "myapp/DB_PASSWORD", "s3cret-v1");
    expect(await getKdbxSecret(home, "myapp/DB_PASSWORD")).toBe("s3cret-v1");
  }, 30_000);

  it("updates an existing entry — this is the path `edit --password` never reached", async () => {
    const home = await freshHome();
    await setKdbxSecret(home, "myapp/DB_PASSWORD", "s3cret-v1");
    await setKdbxSecret(home, "myapp/DB_PASSWORD", "s3cret-v2");
    expect(await getKdbxSecret(home, "myapp/DB_PASSWORD")).toBe("s3cret-v2");
  }, 30_000);

  it("round-trips a default-scope key", async () => {
    const home = await freshHome();
    await setKdbxSecret(home, "TOP_LEVEL", "top-value");
    expect(await getKdbxSecret(home, "TOP_LEVEL")).toBe("top-value");
  }, 30_000);

  it("round-trips a value full of shell metacharacters byte-exact", async () => {
    // The old code single-quote-escaped this into a `sh -c` string. Escaping it correctly
    // was never the problem — being in an argv at all was — but a value like this is what
    // proves the replacement neither mangles nor re-parses it.
    const home = await freshHome();
    const tricky = "va'l\"ue $(id) `whoami` \\ end";
    await setKdbxSecret(home, "myapp/TRICKY", tricky);
    expect(await getKdbxSecret(home, "myapp/TRICKY")).toBe(tricky);
  }, 30_000);

  it("lists and deletes", async () => {
    const home = await freshHome();
    await setKdbxSecret(home, "myapp/A", "a-value");
    await setKdbxSecret(home, "myapp/B", "b-value");

    const listed = await listKdbxSecrets(home);
    expect(listed.total).toBeGreaterThanOrEqual(2);

    await deleteKdbxSecret(home, "myapp/A");
    expect(await getKdbxSecret(home, "myapp/A")).toBeNull();
    expect(await getKdbxSecret(home, "myapp/B")).toBe("b-value");
  }, 30_000);
});
