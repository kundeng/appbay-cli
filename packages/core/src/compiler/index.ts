/**
 * Compiler pipeline -- re-exports for the compiler module.
 */

export { discoverApps } from "./discover.js";
export type {
  DiscoverOptions,
  DiscoveredApp,
  DiscoveryError,
} from "./types.js";

export { ScopeResolver } from "./scope-resolver.js";
export type {
  ScopeValues,
  ScopeError,
  ResolveResult,
} from "./scope-resolver.js";

export { selectActiveOverlays, mergeOverlays } from "./overlay-engine.js";
export type {
  OverlayInput,
  ActiveOverlay,
  InactiveOverlay,
  OverlayResult,
} from "./overlay-engine.js";

export { transformUpstream } from "./upstream-transform.js";
export type {
  UpstreamTransformInput,
  UpstreamTransformOutput,
} from "./upstream-transform.js";

export { applyTraits } from "./trait-engine.js";
export type {
  TraitEngineInput,
  TraitEngineOutput,
  TraitError,
  TraitWarning,
} from "./trait-engine.js";

export { renderCompose } from "./renderer.js";
export type { RenderInput, RenderOutput } from "./renderer.js";

export { generatePlan, redactSecrets } from "./plan.js";
export type { PlanInput, Plan, DiffLine } from "./plan.js";

export { compile } from "./compile.js";
export type {
  CompileOptions,
  CompileResult,
  AppCompileResult,
  CompileError,
  LogicalChangeEntry,
  LogicalGroup,
} from "./compile.js";
