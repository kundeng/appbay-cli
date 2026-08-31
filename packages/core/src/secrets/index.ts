/**
 * Secret resolution module.
 *
 * Re-exports the SecretStore, provider implementations, and shared types for
 * URI-based secret resolution.
 */

// Types
export type { CheckResult, SecretProvider } from "./types.js";

// Store
export { SecretStore } from "./store.js";
export type { ParsedUri } from "./store.js";

// Providers
export { EnvSecretProvider } from "./providers/env.js";
export { FileSecretProvider } from "./providers/file.js";
export type { FileSecretProviderOptions } from "./providers/file.js";
export { SopsSecretProvider } from "./providers/sops.js";
export { VaultSecretProvider, Vault } from "./providers/vault.js";
export { KeePassSecretProvider } from "./providers/keepass.js";

// Deploy-time resolution (CLI shepherd phase 2)
export {
  resolveSecretsForDeploy,
  extractSecretRefs,
  createSecretStore,
} from "./resolve-for-deploy.js";
export type { SecretRef, SecretResolveResult } from "./resolve-for-deploy.js";
export * from "./master-password.js";
