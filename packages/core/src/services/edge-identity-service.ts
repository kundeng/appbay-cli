/** Filesystem ownership and password lifecycle for Caddy Security local identities. */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { EdgeIdentityDocumentSchema, type EdgeIdentityDocument, type EdgeUser } from "../schemas/edge-identities.js";
import { containerBin } from "../runtime/container-runtime.js";

export const EDGE_USERS_RELATIVE_PATH = join("etc", "apps", "caddy", "config", "security", "users.json");
export const DEFAULT_CADDY_SECURITY_IMAGE = "localhost/appbay-caddy-security:2.11.4-v1.1.64";
const PRIVATE_FILE_MODE = 0o600;
const ZERO_TIME = "0001-01-01T00:00:00Z";

/**
 * A valid, empty Caddy Security identity document.
 *
 * ⚠️ Shape must satisfy `EdgeIdentityDocumentSchema` — Caddy Security's own file carries
 * version/policy/revision/timestamps alongside `users`, and the schema is `.passthrough()`
 * so the module's extra fields survive a round trip. `revision: 0` marks a store AppBay
 * created that Caddy Security has not yet taken ownership of; it bumps the revision itself
 * on first provision.
 */
function emptyIdentityDocument(): EdgeIdentityDocument {
  const now = new Date().toISOString();
  return { version: "1.0.0", policy: {}, revision: 0, last_modified: now, loaded_at: now, users: [] };
}

export class EdgeIdentityStore {
  readonly path: string;
  constructor(
    appbayHome: string,
    private readonly passwordHasher: (password: string) => string = hashPassword,
  ) {
    this.path = join(appbayHome, EDGE_USERS_RELATIVE_PATH);
  }

  async read(): Promise<EdgeIdentityDocument> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      // ⚠️ A MISSING FILE IS THE NORMAL FIRST-RUN STATE, NOT A FAILURE. Caddy Security
      // creates users.json when the edge first provisions, so before the edge has ever
      // run there is legitimately no store. Treating ENOENT as fatal made
      // `appbay edge users list` die with a raw stack trace on a fresh install —
      // the first command an operator would reach for.
      //
      // Returning an empty document is also what `create` needs: it reads, appends, and
      // writes, so the first user bootstraps the file rather than requiring the edge to
      // have started first.
      if (code === "ENOENT") return emptyIdentityDocument();

      if (code !== "EACCES" || !claimIdentityStoreOwnership()) {
        throw new Error(`Caddy Security identity store is unavailable at ${this.path}: ${String(error)}`);
      }
      raw = await readFile(this.path, "utf-8").catch((retryError: unknown) => {
        throw new Error(`Caddy Security identity store remains unavailable at ${this.path}: ${String(retryError)}`);
      });
    }
    const parsed = EdgeIdentityDocumentSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`Invalid Caddy Security identity store: ${parsed.error.message}`);
    return parsed.data;
  }

  async write(document: EdgeIdentityDocument): Promise<void> {
    const validated = EdgeIdentityDocumentSchema.parse(document);
    const parent = dirname(this.path);
    const temporary = join(parent, `.users-${process.pid}-${randomUUID()}.tmp`);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const file = await open(temporary, "wx", PRIVATE_FILE_MODE);
    try {
      await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf-8");
      await file.chmod(PRIVATE_FILE_MODE);
      await file.sync();
      await file.close();
      await rename(temporary, this.path);
      await chmod(this.path, PRIVATE_FILE_MODE);
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async create(input: { username: string; email: string; password: string; roles?: string[] }): Promise<EdgeUser> {
    const document = await this.read();
    if (document.users.some((user) => user.username === input.username)) throw new Error(`Edge user '${input.username}' already exists.`);
    const now = new Date().toISOString();
    const domain = input.email.slice(input.email.lastIndexOf("@") + 1);
    const user: EdgeUser = {
      id: randomUUID(), username: input.username,
      email_address: { address: input.email, domain }, email_addresses: [{ address: input.email, domain }],
      passwords: [passwordRecord(this.passwordHasher(input.password), now)], created: now, last_modified: now,
      roles: (input.roles ?? ["user"]).map(toRole),
    };
    await this.write({ ...document, revision: document.revision + 1, last_modified: now, users: [...document.users, user] });
    return user;
  }

  async resetPassword(username: string, password: string): Promise<EdgeUser> {
    const document = await this.read();
    const now = new Date().toISOString();
    let updated: EdgeUser | undefined;
    const users = document.users.map((user) => {
      if (user.username !== username) return user;
      // Password reset revokes every previous credential; retaining historical hashes would
      // make the old password continue to authenticate after a purported reset.
      updated = { ...user, passwords: [passwordRecord(this.passwordHasher(password), now)], last_modified: now };
      return updated;
    });
    if (!updated) throw new Error(`Edge user '${username}' not found.`);
    await this.write({ ...document, revision: document.revision + 1, last_modified: now, users });
    return updated;
  }
}

/**
 * Reload the edge so an identity change actually takes effect.
 *
 * 🚨 A CADDY CONFIG RELOAD DOES NOT REBUILD AUTHCRUNCH'S IN-MEMORY LOCAL IDENTITY STORE.
 * Writing users.json is therefore only half of a mutation: without this narrow restart the
 * file on disk and the identities Caddy will actually authenticate against diverge, and a
 * newly created user simply cannot log in while every command reports success.
 *
 * ⚠️ This lives in core, not in a caller, because BOTH interfaces mutate identities — the
 * CLI (`appbay edge users`) and the web control plane. When it was a private helper in
 * apps/cli, the web had no way to reach it, and the only options were to duplicate the
 * container names or to ship a web surface whose writes silently didn't take.
 *
 * Route manifest changes do NOT come through here — those use the deploy service's
 * zero-downtime validate/reload path. Restarting is reserved for identity writes.
 *
 * Returns false when the edge is not running, which is not an error: the store is read at
 * startup, so an edge that is down will load the change when it next starts.
 */
export function restartEdgeForIdentityChange(): boolean {
  for (const container of ["appbay.caddy.caddy", "appbay.caddy"]) {
    const result = spawnSync(containerBin(), ["restart", container], {
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8",
    });
    if (result.status === 0) return true;
  }
  return false;
}

/**
 * AuthCrunch creates the first bind-mounted users.json as root. Claim only that file for the
 * invoking AppBay operator; Caddy continues to read it as container root. No recursive chown
 * is used, so unrelated edge configuration ownership is untouched.
 */
function claimIdentityStoreOwnership(): boolean {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return false;
  for (const container of ["appbay.caddy.caddy", "appbay.caddy"]) {
    const result = spawnSync(containerBin(), [
      "exec", "--user", "0", container, "sh", "-c",
      `chown ${uid}:${gid} /etc/caddy/security/users.json && chmod 600 /etc/caddy/security/users.json`,
    ], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
    if (result.status === 0) return true;
  }
  return false;
}

function toRole(role: string) {
  const separator = role.indexOf("/");
  return separator < 0
    ? { organization: "authp", name: role }
    : { organization: role.slice(0, separator), name: role.slice(separator + 1) };
}
function passwordRecord(hash: string, createdAt: string) {
  return { purpose: "generic" as const, algorithm: "bcrypt" as const, hash, cost: 10,
    expired_at: ZERO_TIME, created_at: createdAt, disabled_at: ZERO_TIME };
}
function hashPassword(password: string): string {
  const image = process.env.APPBAY_CADDY_IMAGE || DEFAULT_CADDY_SECURITY_IMAGE;
  const result = spawnSync(containerBin(), ["run", "--rm", "-i", "--entrypoint", "caddy", image,
    "hash-password", "--algorithm", "bcrypt", "--bcrypt-cost", "10"], {
    input: `${password}\n`, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`Caddy password hashing failed: ${String(result.stderr).trim()}`);
  const hash = String(result.stdout).trim();
  if (!/^\$2[aby]\$10\$/.test(hash)) throw new Error("Caddy returned an unexpected password hash.");
  return hash;
}
