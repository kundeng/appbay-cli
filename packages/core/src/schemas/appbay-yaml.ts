/**
 * Zod schema for appbay.yaml -- the per-app metadata file.
 *
 * Three logical sections:
 *   1. Scope   – project, environment, collection, operator, shared_network, tags
 *   2. App Model – upstream, overrides, overlays
 *   3. Traits  – app-level and service-level trait configs (discriminated union on `type`)
 *
 * See design.md "Data Models > appbay.yaml Zod Schema" for the canonical reference.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Scope Section
// ---------------------------------------------------------------------------

export const ScopeSchema = z.object({
  /**
   * Deployment namespace, flat and dot-delimited: `uom.sim`. RFC-001 §4.
   *
   * ⚠️ `.optional()`, NOT `.default("default")`, and that one word is the whole point.
   * `project` and `environment` were declared with a default, so after parsing they were
   * never `undefined` — which made `config?.project ?? invocationProject` in compile.ts
   * return the manifest value every time and the invocation value unreachable. Absence has
   * to be expressible for "decided at deploy time" to mean anything.
   */
  namespace: z.string().optional(),
  collection: z.array(z.string()).optional(),
  operator: z.string().optional(),
  shared_network: z.array(z.string()).default(["appbay_shared"]),
  tags: z.record(z.string()).optional(),
});

export type Scope = z.infer<typeof ScopeSchema>;

// ---------------------------------------------------------------------------
// Upstream Section
// ---------------------------------------------------------------------------

/**
 * A service exposed on shared network(s). Three accepted forms:
 *   - string: "api" (expose with original name on default shared network)
 *   - alias map: { web: "dify-web" } (expose with custom alias)
 *   - full object: { service: "api", networks: ["appbay_shared"] }
 */
export const ExposeEntryFullSchema = z.object({
  service: z.string(),
  networks: z.array(z.string()).optional(),
});

export const ExposeEntrySchema = z.union([
  z.string(),
  z.record(z.string(), z.string()),
  ExposeEntryFullSchema,
]);

export type ExposeEntry = z.infer<typeof ExposeEntrySchema>;

export const UpstreamSchema = z.object({
  /** Path to the stock compose file (relative to appbay.yaml). */
  source: z.string().optional(),
  services: z
    .object({
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  expose: z.array(ExposeEntrySchema).optional(),
});

export type Upstream = z.infer<typeof UpstreamSchema>;

// ---------------------------------------------------------------------------
// Overrides Section
// ---------------------------------------------------------------------------

/** Per-service compose overrides -- free-form compose fragments. */
export const OverrideSchema = z.record(z.any());

export type Override = z.infer<typeof OverrideSchema>;

// ---------------------------------------------------------------------------
// Overlay Section
// ---------------------------------------------------------------------------

/**
 * Conditional `when` clause for overlays.
 *
 * - Array of app names = AND logic (all must be active).
 * - `{ any: [...] }` = OR logic (at least one must be active).
 */
export const WhenClauseSchema = z.union([
  z.array(z.string()),
  z.object({ any: z.array(z.string()) }),
]);

export type WhenClause = z.infer<typeof WhenClauseSchema>;

export const OverlaySchema = z.object({
  when: WhenClauseSchema,
  services: z.record(z.any()),
});

export type Overlay = z.infer<typeof OverlaySchema>;

// ---------------------------------------------------------------------------
// Trait Config Schemas (discriminated union on `type`)
// ---------------------------------------------------------------------------

export const IngressTraitSchema = z.object({
  type: z.literal("ingress"),
  host: z.string(),
  port: z.number(),
  exposure: z.enum(["internal", "external", "both"]).default("both"),
  tls: z
    .object({
      staging: z.boolean().default(false),
    })
    .optional(),
  /**
   * Target compose service name. Used when the ingress trait is declared at
   * app level (e.g., in a multi-service app's top-level traits array).
   */
  service: z.string().optional(),
});

export type IngressTrait = z.infer<typeof IngressTraitSchema>;

export const GpuTraitSchema = z.object({
  type: z.literal("gpu"),
  /** GPU passthrough variant. Auto-detected from runtime facts when omitted. */
  variant: z.enum(["nvidia", "cdi", "rocm"]).optional(),
  /** Number of GPUs to allocate. Use -1 for all GPUs. Defaults to 1. */
  count: z.number().default(1),
  /** Explicit CDI device names. Used only with the `cdi` variant. */
  devices: z.array(z.string()).optional(),
  /**
   * Is the GPU essential to this app?
   *
   * `true` (DEFAULT) — a host with no GPU is a compile error and nothing is deployed.
   * `false` — the app deploys without the device reservation and the operator is WARNED.
   *   Opt in only for apps that are genuinely useful on CPU, like Ollama.
   *
   * 🚨 THE DEFAULT IS `true`, AND IT IS NOT ARBITRARY. Journey 15 of the alpha gate
   * (`scripts/journeys/s26-journey-degradation.sh`) requires that a GPU trait on a
   * GPU-less host deploys NOTHING, and its reasoning outranks convenience: an app that
   * deploys "successfully" without its GPU looks healthy in every listing and fails hours
   * later when a model load times out, far from the cause. Silent CPU fallback is the
   * expensive failure, not the safe one.
   *
   * ⚠️ This shipped as `default(false)` for exactly one commit and broke that journey.
   * Fixing the cryptic `could not select device driver "nvidia"` runtime error did NOT
   * require deploying anyway — it required refusing *clearly*, which is what this does.
   *
   * EP1: which apps can survive on CPU is a property of the app, so it is declared in the
   * manifest rather than decided by a rule inside the trait.
   */
  required: z.boolean().default(true),
  /**
   * Target compose service name. Required for app-level GPU trait declarations.
   * Service-level declarations inherit the service name from the YAML key.
   */
  service: z.string().optional(),
});

export type GpuTrait = z.infer<typeof GpuTraitSchema>;

export const AuthTraitSchema = z.object({
  type: z.literal("auth"),
  mode: z.enum(["portal"]).default("portal"),
  enabled: z.boolean().default(true),
  service: z.string().optional(),
  /** Caddy Security access policy. MFA is configured on the identity provider/portal. */
  policy: z.enum(["authenticated", "deny"]).default("authenticated"),
  /** Optional identity role required in addition to the built-in admin role. */
  group: z.string().optional(),
});

export type AuthTrait = z.infer<typeof AuthTraitSchema>;

export const NamespaceShareSchema = z.object({
  network: z.boolean().optional().default(false),
  pid: z.boolean().optional().default(false),
  ipc: z.boolean().optional().default(false),
}).optional();

export type NamespaceShare = z.infer<typeof NamespaceShareSchema>;

export const HooksTraitSchema = z.object({
  type: z.literal("hooks"),
  pattern: z.enum(["init", "sidecar", "config"]),
  image: z.string().optional(),
  command: z.string().optional(),
  /** Inline content for the `config` pattern. */
  content: z.string().optional(),
  volumes: z.array(z.string()).optional(),
  /**
   * Target compose service name. Used when the hooks trait is declared at
   * app level (e.g., in a multi-service app's top-level traits array).
   * Service-level declarations inherit the service name from the YAML key.
   */
  service: z.string().optional(),
  /** Namespace sharing with the target container. */
  share: NamespaceShareSchema,
});

export type HooksTrait = z.infer<typeof HooksTraitSchema>;

export const SecretsTraitSchema = z.object({
  type: z.literal("secrets"),
  /**
   * Which service receives the secrets. Optional, as elsewhere — but its ABSENCE used to
   * be unrecoverable for file-based modes: with no explicit target the trait guessed by
   * looking for services whose `environment` already mentions the secret keys, and
   * `wrapper-file` exists precisely so that secrets are NOT in the environment. The guess
   * therefore matched nothing for a correctly-written app. See the fallback in
   * traits/definitions/secrets.ts.
   */
  service: z.string().optional(),
  provider: z.enum(["vault", "keepass", "file", "env", "sops"]).default("vault"),
  /** Map of env_var_name to secret URI. */
  refs: z.record(z.string()),
  /** Ref keys allowed to be absent. They are omitted from the deploy environment. */
  optional: z.array(z.string()).optional(),
  injection: z.enum(["none", "runtime-env", "wrapper-file", "entrypoint-wrapper", "wrapper-live"]).default("runtime-env"),
});

export type SecretsTrait = z.infer<typeof SecretsTraitSchema>;

export const BackupTraitSchema = z.object({
  type: z.literal("backup"),
  /** Cron expression for backup schedule. */
  schedule: z.string(),
  retention: z.number().default(7),
  volumes: z.array(z.string()).optional(),
});

export type BackupTrait = z.infer<typeof BackupTraitSchema>;

export const ScopedEnvTraitSchema = z.object({
  type: z.literal("scoped-env"),
  /** Map of env key to `${{scope.KEY}}` reference or generator expression. */
  vars: z.record(z.string()),
});

export type ScopedEnvTrait = z.infer<typeof ScopedEnvTraitSchema>;

/**
 * Discriminated union of all trait configs.
 * The `type` field is the discriminator.
 */
export const TraitConfigSchema = z.discriminatedUnion("type", [
  IngressTraitSchema,
  GpuTraitSchema,
  AuthTraitSchema,
  HooksTraitSchema,
  SecretsTraitSchema,
  BackupTraitSchema,
  ScopedEnvTraitSchema,
]);

export type TraitConfig = z.infer<typeof TraitConfigSchema>;

// ---------------------------------------------------------------------------
// Service-level traits
// ---------------------------------------------------------------------------

export const ServiceTraitsSchema = z.object({
  traits: z.array(TraitConfigSchema).optional(),
});

export type ServiceTraits = z.infer<typeof ServiceTraitsSchema>;

// ---------------------------------------------------------------------------
// Policies Section
// ---------------------------------------------------------------------------

export const ConflictPolicySchema = z.object({
  traits: z.array(z.string()),
  action: z.enum(["error", "warn"]).default("error"),
});

export type ConflictPolicy = z.infer<typeof ConflictPolicySchema>;

export const PoliciesSchema = z.object({
  conflicts: z.array(ConflictPolicySchema).optional(),
});

export type Policies = z.infer<typeof PoliciesSchema>;

// ---------------------------------------------------------------------------
// Vars — UI-configurable variables
// ---------------------------------------------------------------------------

export const VarDefinitionSchema = z.object({
  description: z.string(),
  type: z.enum(["string", "number", "boolean", "secret", "path"]).default("string"),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  auto_generate: z.boolean().optional(),
});

export type VarDefinition = z.infer<typeof VarDefinitionSchema>;

// ---------------------------------------------------------------------------
// Full appbay.yaml Schema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Build specs — what compose cannot say about a `build:` block
// ---------------------------------------------------------------------------

/**
 * Gate a build on instance configuration.
 *
 * ⚠️ Deliberately NOT the overlay `when:` clause. That one keys on which OTHER APPS are
 * deployed, which is a different question — "is ollama running" cannot answer "does this
 * installation use DNS-01". Reusing it would have meant one word with two meanings, which
 * is the mistake `profile` already made in this codebase.
 *
 * Values are compared as strings against `$APPBAY_HOME/project.yaml`. All keys must match.
 */
export const BuildWhenSchema = z.object({
  instance: z.record(z.string()),
});

/**
 * A claim the built image must satisfy, checked by running a command inside it.
 *
 * 🚨 THIS IS THE GATE THAT MAKES A SILENT FAILURE LOUD, and it is the reason `builds` is a
 * manifest concept rather than pure compose. A Caddy image without the DNS provider module
 * does not error — it falls back to the internal issuer and serves a certificate nobody
 * trusts, indefinitely. `verify` turns "looks healthy" into "deploy refused".
 *
 * Expressed as DATA, not code: a command and a substring its output must contain. That
 * keeps appbay from growing a per-image special case for every provider.
 */
export const BuildVerifySchema = z.object({
  command: z.array(z.string()).min(1),
  contains: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
});

export const BuildSpecSchema = z.object({
  /**
   * The image tag the build produces AND the service runs.
   *
   * 🚨 REQUIRED, and it is the single source of truth for the name. The upstream compose
   * says HOW to build (context, dockerfile); this says WHAT it is called. Letting the
   * compose's own `image:` carry it would mean resolving `${VAR:-default}` at compile time,
   * and a service that builds one tag while running another is a failure that looks like a
   * stale cache.
   */
  image: z.string().min(1),
  when: BuildWhenSchema.optional(),
  verify: BuildVerifySchema.optional(),
  /**
   * If this image reference is already available, use it instead of building.
   *
   * ⚠️ The escape hatch for hosts where a toolchain build in the deploy path is not
   * acceptable — a borrowed preprod box, or anywhere the image should come from a registry
   * that CI populated. Same manifest, different behaviour per host.
   */
  pull_if_present: z.string().optional(),
});

export type BuildSpec = z.infer<typeof BuildSpecSchema>;

export const AppbayYamlSchema = z.object({
  // -- Scope --
  /** See ScopeSchema.namespace — optional so the invocation can win. RFC-001 §4. */
  namespace: z.string().optional(),
  collection: z.array(z.string()).optional(),
  operator: z.string().optional(),
  shared_network: z.array(z.string()).default(["appbay_shared"]),
  tags: z.record(z.string()).optional(),

  // -- Application Model --
  upstream: UpstreamSchema.optional(),
  overrides: z.record(OverrideSchema).optional(),
  overlays: z.array(OverlaySchema).optional(),

  // -- Traits (app-level) --
  traits: z.array(TraitConfigSchema).optional(),

  /**
   * Per-service build policy, keyed by compose service name.
   *
   * The upstream compose keeps its `build:` block — it stays a valid compose file that a
   * human can read and run. appbay HOISTS it: builds ahead of deploy, pins `image:` to the
   * tag below, and STRIPS `build:` from the rendered output.
   *
   * ⚠️ Stripping is the point, not tidiness. A rendered compose that still carries `build:`
   * puts an implicit image build inside `compose up` — and on podman's compat API that is
   * the least-tested path in this whole stack (measured: `no such image` on an image podman
   * demonstrably held). After hoisting, the render is a pure "run this image".
   */
  builds: z.record(BuildSpecSchema).optional(),

  // -- Service-level trait overrides --
  services: z.record(ServiceTraitsSchema).optional(),

  // -- Policies --
  policies: PoliciesSchema.optional(),

  // -- UI-configurable variables --
  // Explicit declarations of variables the UI should expose for editing.
  // Keys are env var names, values describe type, description, and defaults.
  // Current values live in .env.local (not here). This is the schema, not state.
  vars: z.record(VarDefinitionSchema).optional(),

  // -- Model initialization --
  // Models to auto-pull on first deploy (e.g., Ollama models).
  // Skipped if the service already has models downloaded.
  default_models: z.array(z.string()).optional(),
});

export type AppbayYaml = z.infer<typeof AppbayYamlSchema>;
