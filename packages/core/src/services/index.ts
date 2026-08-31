/**
 * Service modules — shared business logic for CLI and tRPC.
 *
 * These modules compose core primitives (Vault, SecretStore, compile, etc.)
 * into complete operations. Both CLI commands and tRPC routers call these
 * functions — enforcing the "one API, two interfaces" architectural rule.
 */

// Vault service (secret vault CRUD, scanning, password resolution)
export * from "./vault-service.js";

// Deploy service (shepherd pipeline: compile → deploy → post-deploy)
export * from "./deploy-service.js";

// Config service (appbay.yaml + .env file management)
export * from "./config-service.js";

// Catalog service (browse, search, install from catalog)
export * from "./catalog-service.js";

// AppBay control-plane identities (filesystem source of truth)
export * from "./control-plane-user-service.js";
export * from "./edge-identity-service.js";

// Caddy Security portal/identity block rendering
export * from "./edge-portal-config.js";
export * from "./edge-caddy-files.js";
export * from "./control-plane-edge.js";

// Recoverable edge stack migration (one host, one edge)
export * from "./edge-migration-service.js";
