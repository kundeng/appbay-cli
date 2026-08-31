/**
 * Type definitions for the Appbay trait system.
 *
 * Traits are reusable transformations that add/change behavior in the Compose
 * model. Inspired by OAM (Open Application Model) traits, adapted for
 * single-node Docker Compose.
 *
 * See agents.md "Trait model" and design.md "Trait System" for details.
 */

import type { z } from "zod";
import type { IngressProvider } from "../schemas/instance.js";
import type { RuntimeFacts } from "../schemas/runtime-facts.js";

// ---------------------------------------------------------------------------
// Trait Scope & Category
// ---------------------------------------------------------------------------

/** Whether a trait applies to a single service or to the entire app. */
export type TraitScope = "service" | "app";

/** Core traits are built-in; extension traits are user-provided (future). */
export type TraitCategory = "core" | "extension";

// ---------------------------------------------------------------------------
// Compiler Context (subset needed by trait transforms)
// ---------------------------------------------------------------------------

/** Context passed to trait transforms during compilation. */
export interface CompilerContext {
  /** Deployment namespace from appbay.yaml scope, or "default". RFC-001 §4. */
  namespace: string;
  /** App name (directory name). */
  appName: string;
  /** Path to the apps directory ($APPBAY_HOME/etc/apps). */
  appsDir: string;
  /** Runtime facts reported by the app operator. */
  runtimeFacts: RuntimeFacts;
  /**
   * Reverse proxy fronting this installation, resolved once per compile from
   * $APPBAY_HOME/project.yaml.
   *
   * ⚠️ Optional so that existing callers (and every current test) keep compiling;
   * absent means `traefik`. It is installation-level rather than per-app because every
   * app on a host is routed by the same proxy — see IngressProviderSchema.
   */
  ingressProvider?: IngressProvider;
}

// ---------------------------------------------------------------------------
// Trait Transform I/O
// ---------------------------------------------------------------------------

/** Input to a trait's transform function. */
export interface TraitTransformInput {
  /** App name (directory name). */
  app: string;
  /** Service name (for service-scoped traits). Undefined for app-scoped traits. */
  service?: string;
  /** Trait properties, already validated against the trait's Zod schema. */
  properties: unknown;
  /** Current compose state as a mutable record. */
  compose: Record<string, unknown>;
  /** Compiler context with project/environment/runtime info. */
  context: CompilerContext;
  /**
   * Every other trait declared on this app — app-level and service-level — excluding
   * this one. Raw declared configuration, before each trait's own Zod parse.
   *
   * 🚨 EXISTS BECAUSE TRAITS THAT MUST AGREE ON A VALUE HAD NO WAY TO. The auth trait
   * needs the host the ingress trait routes, and without this it guessed:
   * `resolveIngressHost` returned `${app}.local` unconditionally, under a section header
   * claiming to resolve it from the sibling ingress trait. That value is the `domain` of
   * the edge authorization policy. On any real domain the guessed rule protected nothing.
   *
   * ⚠️ READ TO AGREE, NEVER TO OVERRIDE. A trait may consult a sibling's declared
   * configuration so the two produce consistent output. It must not modify a sibling, and
   * it must not depend on whether the sibling has already been transformed — this is the
   * DECLARED config, not the sibling's output, so there is no ordering dependency and no
   * cycle. Anything that needs a sibling's *output* is a compiler concern, not a trait one.
   */
  siblingTraits: ReadonlyArray<{ type: string; [key: string]: unknown }>;
}

/** Phase in the deploy lifecycle when a shepherd action runs. */
export type ShepherdPhase = "pre-deploy" | "post-deploy" | "on-stop" | "cron";

/** A shepherd action emitted by a trait — an operational task tied to a lifecycle phase. */
export interface ShepherdAction {
  phase: ShepherdPhase;
  /** Human-readable label (e.g., "Generate edge authorization policy"). */
  label: string;
  /** Docker image for the shepherd container. */
  image?: string;
  /** Command to run. */
  command?: string[];
  /** Namespace sharing with the target. */
  share?: { network?: boolean; pid?: boolean; ipc?: boolean };
  /** Volume mounts. */
  mounts?: Array<{ source: string; target: string; readonly?: boolean }>;
  /** Environment variables for the shepherd container. */
  env?: Record<string, string>;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Cron expression (only for phase: "cron"). */
  schedule?: string;
  /** Async function to execute instead of a container (for in-process actions). */
  run?: (ctx: { appName: string; appbayHome: string; secretEnv?: Record<string, string> }) => Promise<unknown>;
}

/** Output from a trait's transform function. */
export interface TraitTransformOutput {
  /** Modified compose state. */
  compose: Record<string, unknown>;
  /** Optional auxiliary files generated by this trait (e.g., Traefik config). */
  auxiliaryFiles?: Array<{ path: string; content: string }>;
  /** Optional metadata for downstream pipeline stages. */
  metadata?: Record<string, unknown>;
  /** Optional shepherd actions — operational tasks tied to deploy lifecycle phases. */
  shepherd?: ShepherdAction[];
  /** Semantic errors discovered after schema parsing (for example, incompatible modes). */
  errors?: string[];
  /**
   * Non-fatal findings the operator must see — a trait that degraded rather than applied,
   * a capability the host cannot provide.
   *
   * ⚠️ `TraitWarning` and the `warnings` array on the trait-engine result predate this by
   * some time and had NO producers: the channel was declared, threaded through the
   * compiler and surfaced by the CLI, and no trait could put anything in it. A trait that
   * needed to say something non-fatal had to choose between `errors` (which fails the
   * app) and silence, and silence usually won.
   */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Trait Definition
// ---------------------------------------------------------------------------

/**
 * A trait definition registers a reusable transformation with the trait
 * registry. Each core trait (ingress, gpu, auth, hooks, secrets, backup,
 * scoped-env) implements this interface.
 *
 * OAM rules enforced by the registry:
 *  - One configuration per trait type per service.
 *  - Traits applied in declaration order.
 *  - `conflictsWith` declares incompatible traits.
 */
export interface TraitDefinition<T extends string = string> {
  /** Unique trait type identifier (e.g., "ingress", "gpu"). */
  type: T;
  /** Core traits are built-in; extension traits are user-provided (future). */
  category: TraitCategory;
  /** Whether this trait applies to a service or to the whole app. */
  scope: TraitScope;
  /** Trait types that conflict with this one. */
  conflictsWith: string[];
  /** Human-readable description of what this trait does. */
  description: string;
  /** Zod schema for validating trait properties in appbay.yaml. */
  schema: z.ZodType;
  /** Transform function that modifies compose state and produces artifacts. */
  transform(input: TraitTransformInput): TraitTransformOutput;
}

// ---------------------------------------------------------------------------
// Conflict & Validation Results
// ---------------------------------------------------------------------------

/** Result of detecting a conflict between two traits. */
export interface ConflictResult {
  /** First conflicting trait type. */
  traitA: string;
  /** Second conflicting trait type. */
  traitB: string;
  /** Human-readable conflict message. */
  message: string;
}

/** Result of validating a trait assignment. */
export interface ValidationResult {
  /** Whether the assignment is valid. */
  valid: boolean;
  /** Error messages if invalid. */
  errors: string[];
}
