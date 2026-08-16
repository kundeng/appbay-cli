/**
 * Core trait definitions index.
 *
 * Registers all 7 built-in trait definitions with a TraitRegistry instance.
 * v1: all traits are compiled in (static). Future: hybrid with dynamic
 * extension loading.
 */

import type { TraitRegistry } from "../registry.js";
import { ingressTraitDefinition } from "./ingress.js";
import { gpuTraitDefinition } from "./gpu.js";
import { authTraitDefinition } from "./auth.js";
import { hooksTraitDefinition } from "./hooks.js";
import { secretsTraitDefinition } from "./secrets.js";
import { backupTraitDefinition } from "./backup.js";
import { scopedEnvTraitDefinition } from "./scoped-env.js";

/** All core trait definitions in registration order. */
export const coreTraitDefinitions = [
  ingressTraitDefinition,
  gpuTraitDefinition,
  authTraitDefinition,
  hooksTraitDefinition,
  secretsTraitDefinition,
  backupTraitDefinition,
  scopedEnvTraitDefinition,
] as const;

/** Register all core trait definitions with the given registry. */
export function registerCoreTraits(registry: TraitRegistry): void {
  for (const definition of coreTraitDefinitions) {
    registry.register(definition);
  }
}

// Re-export individual definitions for direct access.
export { ingressTraitDefinition } from "./ingress.js";
export { gpuTraitDefinition } from "./gpu.js";
export { authTraitDefinition } from "./auth.js";
export { hooksTraitDefinition } from "./hooks.js";
export { secretsTraitDefinition } from "./secrets.js";
export { backupTraitDefinition } from "./backup.js";
export { scopedEnvTraitDefinition } from "./scoped-env.js";
