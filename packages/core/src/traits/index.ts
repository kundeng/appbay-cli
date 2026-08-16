/**
 * Trait system re-exports.
 *
 * Provides the TraitRegistry class, type definitions, core trait definitions,
 * and the `registerCoreTraits` helper.
 */

// Types
export type {
  TraitScope,
  TraitCategory,
  CompilerContext,
  TraitTransformInput,
  TraitTransformOutput,
  TraitDefinition,
  ConflictResult,
  ValidationResult,
} from "./types.js";

// Registry
export { TraitRegistry } from "./registry.js";

// Core trait definitions and registration helper
export {
  coreTraitDefinitions,
  registerCoreTraits,
  ingressTraitDefinition,
  gpuTraitDefinition,
  authTraitDefinition,
  hooksTraitDefinition,
  secretsTraitDefinition,
  backupTraitDefinition,
  scopedEnvTraitDefinition,
} from "./definitions/index.js";
