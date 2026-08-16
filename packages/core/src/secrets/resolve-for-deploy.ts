/**
 * Deploy-time secret resolution.
 *
 * Called by the CLI shepherd (phase 2) between compile and docker compose up.
 * Takes the secretRefs from compile output's traitMetadata and resolves each
 * URI via the SecretStore. Returns a flat env map that the caller injects as
 * process environment to the docker compose child process.
 *
 * The resolved values NEVER touch disk — they exist in-memory only and are
 * passed to docker compose via the process env chain:
 *
 *   CLI process env → docker compose child → container env
 *
 * This is the `op run --` / `ks run --` pattern from the steering doc.
 */

import { SecretStore } from "./store.js";
import { EnvSecretProvider } from "./providers/env.js";
import { FileSecretProvider } from "./providers/file.js";
import { SopsSecretProvider } from "./providers/sops.js";
import { VaultSecretProvider } from "./providers/vault.js";
import { KeePassSecretProvider } from "./providers/keepass.js";
import { runShepherd } from "../shepherd/run-shepherd.js";
import { containerBin } from "../runtime/container-runtime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A secret reference from compile output's traitMetadata. */
export interface SecretRef {
  /** Environment variable name (e.g., "DB_PASSWORD"). */
  key: string;
  /** Secret URI (e.g., "vault://app/DB_PASSWORD"). */
  uri: string;
  /** Provider hint from the trait config. */
  provider?: string;
  /** Injection mode: "runtime-env" or "wrapper". */
  injection?: string;
  /** App name. */
  app: string;
  /** Service name within the app. */
  service?: string;
  /** Missing values are omitted rather than failing the deploy. */
  optional?: boolean;
}

/** Result of resolving all secrets for a deploy. */
export interface SecretResolveResult {
  /** Flat map of env var name → resolved value. */
  env: Record<string, string>;
  /** Errors encountered during resolution (URI → error message). */
  errors: Array<{ ref: SecretRef; error: string }>;
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

/**
 * Create a SecretStore with all core providers registered.
 *
 * Each URI scheme is unambiguous and always resolves to one backend:
 *   - `vault://`   → AES-256-GCM encrypted JSON (vault.enc)
 *   - `keepass://`  → KeePass .kdbx via keepassxc-cli
 *   - `file://`     → File on disk
 *   - `env://`      → Environment variable
 *   - `sops://`     → SOPS encrypted file
 *
 * @param options.autoGenerate - Whether the file provider auto-generates
 *   missing secrets (default: true).
 */
export function createSecretStore(
  options: { autoGenerate?: boolean } = {},
): SecretStore {
  const store = new SecretStore();
  store.registerProvider(new EnvSecretProvider());
  store.registerProvider(new FileSecretProvider({
    autoGenerate: options.autoGenerate ?? true,
  }));
  store.registerProvider(new SopsSecretProvider());
  store.registerProvider(new VaultSecretProvider());
  store.registerProvider(new KeePassSecretProvider());
  return store;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve all secret refs from compile output and return a flat env map.
 *
 * Called by the CLI shepherd after compile, before docker compose up.
 * Each ref's URI is resolved via the matching SecretStore provider.
 * Errors are collected (not thrown) so partial resolution is possible.
 *
 * Only handles `injection: "runtime-env"` refs. Wrapper-mode refs are
 * skipped (not yet implemented — future version).
 *
 * @param refs - Secret references from compile output's traitMetadata.
 * @param store - Optional pre-configured SecretStore. If omitted, a default
 *   store with all core providers is created.
 * @returns Resolved env map and any errors encountered.
 */
export async function resolveSecretsForDeploy(
  refs: SecretRef[],
  store?: SecretStore,
): Promise<SecretResolveResult> {
  const secretStore = store ?? createSecretStore();
  const env: Record<string, string> = {};
  const errors: SecretResolveResult["errors"] = [];

  const runtimeRefs = refs.filter(
    (r) => !r.injection || r.injection === "runtime-env",
  );

  for (const ref of runtimeRefs) {
    try {
      const value = await secretStore.resolve(ref.uri);
      env[ref.key] = value;
    } catch (err) {
      if (ref.optional) continue;
      errors.push({
        ref,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { env, errors };
}

// ---------------------------------------------------------------------------
// Encrypted bundle for entrypoint-wrapper injection
// ---------------------------------------------------------------------------

const HKDF_SALT = "appbay-inject-v1";
const HKDF_INFO = "secret-injection";

export interface BundleWriteResult {
  volumeName: string;
  secretCount: number;
  errors: Array<{ ref: SecretRef; error: string }>;
}

function deriveKey(seed: Buffer, appName: string): Buffer {
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  // HKDF extract
  const ikm = Buffer.concat([seed, Buffer.from(appName)]);
  const prk = createHmac("sha256", Buffer.from(HKDF_SALT)).update(ikm).digest();
  // HKDF expand (single block, 32 bytes)
  const info = Buffer.from(HKDF_INFO);
  const block = Buffer.concat([info, Buffer.from([1])]);
  return createHmac("sha256", prk).update(block).digest();
}

function encryptBundle(plaintext: Buffer, key: Buffer): Buffer {
  const { createCipheriv, randomBytes: rb } = require("node:crypto") as typeof import("node:crypto");
  const nonce = rb(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: nonce (12) + ciphertext + tag (16) — matches Rust aes-gcm default
  return Buffer.concat([nonce, encrypted, tag]);
}

/**
 * Write an encrypted secret bundle + seed + mapping to a Docker volume.
 *
 * Used by the entrypoint-wrapper injection mode. The appbay-inject binary
 * reads these files at container start time.
 */
export async function writeEncryptedBundle(
  refs: SecretRef[],
  appName: string,
  mapping: Record<string, Record<string, string>>,
  store?: SecretStore,
): Promise<BundleWriteResult> {
  const { randomBytes: rb } = await import("node:crypto");
  const { spawnSync } = await import("node:child_process");
  const secretStore = store ?? createSecretStore();
  const volumeName = `appbay-secrets-${appName}`;
  const errors: BundleWriteResult["errors"] = [];

  const wrapperRefs = refs.filter(
    (r) => r.injection === "entrypoint-wrapper",
  );

  // Resolve all secrets
  const secrets: Record<string, string> = {};
  for (const ref of wrapperRefs) {
    try {
      secrets[ref.key] = await secretStore.resolve(ref.uri);
    } catch (err) {
      errors.push({ ref, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (Object.keys(secrets).length === 0) {
    return { volumeName, secretCount: 0, errors };
  }

  // Generate seed and derive key
  const seed = rb(32);
  const key = deriveKey(seed, appName);

  // Encrypt secrets JSON
  const plaintext = Buffer.from(JSON.stringify(secrets));
  const encrypted = encryptBundle(plaintext, key);

  // Create volume
  spawnSync(containerBin(), ["volume", "create", volumeName], { stdio: "pipe" });

  // Write all three files via a single shepherd container
  const seedHex = seed.toString("hex");
  const bundleB64 = encrypted.toString("base64");
  const mappingJson = JSON.stringify(mapping);

  const writeCmd = [
    `mkdir -p /out`,
    `echo '${seedHex}' > /out/seed`,
    `echo '${bundleB64}' | base64 -d > /out/bundle.enc`,
    `cat > /out/mapping.json << 'MAPEOF'\n${mappingJson}\nMAPEOF`,
  ].join(" && ");

  const result = await runShepherd({
    target: `appbay.${appName}`,
    image: "busybox:latest",
    command: ["sh", "-c", writeCmd],
    mounts: [{ source: volumeName, target: "/out" }],
    timeoutMs: 15_000,
  });

  if (result.exitCode !== 0) {
    errors.push({
      ref: wrapperRefs[0]!,
      error: `Bundle write failed (exit ${result.exitCode}): ${result.stderr}`,
    });
  }

  return { volumeName, secretCount: Object.keys(secrets).length, errors };
}

// ---------------------------------------------------------------------------
// Wrapper-file resolution
// ---------------------------------------------------------------------------

export interface WrapperFileResult {
  volumeName: string;
  filesWritten: number;
  errors: Array<{ ref: SecretRef; error: string }>;
}

/**
 * Resolve wrapper-file secrets and write them to a Docker volume.
 *
 * Uses a one-shot shepherd container to write resolved secret values
 * as files into a shared volume. The target service mounts this volume
 * at `/run/secrets/<app>:ro`.
 *
 * Flow:
 *   1. Resolve all wrapper-file refs via SecretStore
 *   2. Launch `docker run --rm -v <vol>:/out busybox sh -c 'echo ... > /out/<key>'`
 *   3. Target service reads files at startup — no env exposure
 */
export async function resolveWrapperFileSecrets(
  refs: SecretRef[],
  appName: string,
  store?: SecretStore,
): Promise<WrapperFileResult> {
  const secretStore = store ?? createSecretStore();
  const volumeName = `appbay-secrets-${appName}`;
  const errors: WrapperFileResult["errors"] = [];

  const wrapperRefs = refs.filter((r) => r.injection === "wrapper-file" || r.injection === "entrypoint-wrapper");
  if (wrapperRefs.length === 0) {
    return { volumeName, filesWritten: 0, errors };
  }

  const resolved: Array<{ key: string; value: string }> = [];
  for (const ref of wrapperRefs) {
    try {
      const value = await secretStore.resolve(ref.uri);
      resolved.push({ key: ref.key, value });
    } catch (err) {
      errors.push({
        ref,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (resolved.length === 0) {
    return { volumeName, filesWritten: 0, errors };
  }

  // Ensure the external volume exists
  const { spawnSync } = await import("node:child_process");
  spawnSync(containerBin(), ["volume", "create", volumeName], { stdio: "pipe" });

  // Build a shell command that writes each secret to a file
  const writeCommands = resolved.map(({ key, value }) => {
    const escaped = value.replace(/'/g, "'\\''");
    return `printf '%s' '${escaped}' > /out/${key}`;
  });

  const result = await runShepherd({
    target: `appbay.${appName}`,
    image: "busybox:latest",
    command: ["sh", "-c", writeCommands.join(" && ")],
    mounts: [{ source: volumeName, target: "/out" }],
    timeoutMs: 15_000,
  });

  if (result.exitCode !== 0) {
    errors.push({
      ref: wrapperRefs[0],
      error: `Shepherd write failed (exit ${result.exitCode}): ${result.stderr}`,
    });
    return { volumeName, filesWritten: 0, errors };
  }

  return { volumeName, filesWritten: resolved.length, errors };
}

/**
 * Extract all secretRefs from compile output's per-app traitMetadata.
 *
 * The trait engine merges each trait's metadata directly into traitMetadata
 * via Object.assign, so the secrets trait's output `{ secretRefs: [...] }`
 * becomes `traitMetadata.secretRefs` (not `traitMetadata.secrets.secretRefs`).
 */
export function extractSecretRefs(
  traitMetadata: Record<string, unknown>,
): SecretRef[] {
  const refs = traitMetadata["secretRefs"];
  if (!Array.isArray(refs)) return [];
  return refs as SecretRef[];
}
