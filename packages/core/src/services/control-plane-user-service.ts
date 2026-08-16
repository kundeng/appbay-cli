/** Filesystem source of truth for AppBay control-plane identities. */

import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ControlPlaneUsersDocumentSchema,
  ControlPlaneUserSchema,
  type ControlPlaneUser,
  type ControlPlaneUsersDocument,
} from "../schemas/control-plane-users.js";

export const CONTROL_PLANE_USERS_RELATIVE_PATH = join(
  "etc",
  "control-plane",
  "users.yaml",
);

const PRIVATE_FILE_MODE = 0o600;
const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;

/** Hash a control-plane password in the format shared by the file and cache mirror. */
export function hashControlPlanePassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString("hex");
  return `${salt}:${hash}`;
}

export class ControlPlaneUserStore {
  readonly path: string;

  constructor(appbayHome: string) {
    this.path = join(appbayHome, CONTROL_PLANE_USERS_RELATIVE_PATH);
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async read(): Promise<ControlPlaneUsersDocument | null> {
    let content: string;
    try {
      content = await readFile(this.path, "utf-8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }

    const parsed = ControlPlaneUsersDocumentSchema.safeParse(parseYaml(content));
    if (!parsed.success) {
      throw new Error(
        `Invalid AppBay control-plane user file at ${this.path}: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  async write(document: ControlPlaneUsersDocument): Promise<void> {
    const validated = ControlPlaneUsersDocumentSchema.parse(document);
    const parent = dirname(this.path);
    const temporaryPath = join(parent, `.users-${process.pid}-${randomUUID()}.tmp`);
    await mkdir(parent, { recursive: true, mode: 0o700 });

    const file = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    try {
      await file.writeFile(stringifyYaml(validated), "utf-8");
      await file.chmod(PRIVATE_FILE_MODE);
      await file.sync();
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await file.close();

    try {
      await rename(temporaryPath, this.path);
      await chmod(this.path, PRIVATE_FILE_MODE);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async add(user: ControlPlaneUser): Promise<ControlPlaneUsersDocument> {
    const current = (await this.read()) ?? { version: 1 as const, users: [] };
    const next = ControlPlaneUsersDocumentSchema.parse({
      ...current,
      users: [...current.users, user],
    });
    await this.write(next);
    return next;
  }

  async create(username: string, password: string): Promise<ControlPlaneUser> {
    const current = (await this.read()) ?? { version: 1 as const, users: [] };
    if (current.users.some((user) => user.username === username)) {
      throw new Error(`Local AppBay user '${username}' already exists.`);
    }

    const now = new Date().toISOString();
    const user = ControlPlaneUserSchema.parse({
      id: randomUUID(),
      username,
      passwordHash: hashControlPlanePassword(password),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await this.write({ ...current, users: [...current.users, user] });
    return user;
  }

  async replacePasswordHash(
    username: string,
    passwordHash: string,
    updatedAt = new Date().toISOString(),
  ): Promise<ControlPlaneUser> {
    const current = await this.read();
    if (!current) {
      throw new Error(`No AppBay control-plane users exist at ${this.path}.`);
    }

    let changed: ControlPlaneUser | undefined;
    const users = current.users.map((user) => {
      if (user.username !== username) return user;
      changed = { ...user, passwordHash, updatedAt };
      return changed;
    });
    if (!changed) throw new Error(`Local AppBay user '${username}' not found.`);

    await this.write({ ...current, users });
    return changed;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
