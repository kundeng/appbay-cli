/**
 * Re-export all Zod schemas and inferred types for appbay.yaml.
 */
export {
  // Scope
  ScopeSchema,
  type Scope,

  // Upstream
  ExposeEntrySchema,
  type ExposeEntry,
  UpstreamSchema,
  type Upstream,

  // Overrides
  OverrideSchema,
  type Override,

  // Overlays
  WhenClauseSchema,
  type WhenClause,
  OverlaySchema,
  type Overlay,

  // Trait configs
  IngressTraitSchema,
  type IngressTrait,
  GpuTraitSchema,
  type GpuTrait,
  AuthTraitSchema,
  type AuthTrait,
  HooksTraitSchema,
  type HooksTrait,
  SecretsTraitSchema,
  type SecretsTrait,
  BackupTraitSchema,
  type BackupTrait,
  ScopedEnvTraitSchema,
  type ScopedEnvTrait,
  TraitConfigSchema,
  type TraitConfig,

  // Service-level traits
  ServiceTraitsSchema,
  type ServiceTraits,

  // Policies
  ConflictPolicySchema,
  type ConflictPolicy,
  PoliciesSchema,
  type Policies,

  // Full schema
  AppbayYamlSchema,
  type AppbayYaml,
} from "./appbay-yaml.js";

export {
  // Project config
  ProjectConfigSchema,
  type ProjectConfig,

  // Environment config
  EnvironmentConfigSchema,
  type EnvironmentConfig,
} from "./project.js";

export {
  // Generated values
  GeneratedValueKeySchema,
  type GeneratedValueKey,
  GeneratedValueSchema,
  type GeneratedValue,
  GeneratedValuesFileSchema,
  type GeneratedValuesFile,

  // Active apps
  AppStatusSchema,
  type AppStatus,
  ActiveAppEntrySchema,
  type ActiveAppEntry,
  ActiveAppsSchema,
  type ActiveApps,

  // Deploy records
  DeployStatusSchema,
  type DeployStatus,
  DeployRecordSchema,
  type DeployRecord,
} from "./state.js";

export {
  // Catalog
  RequiredInputSchema,
  type RequiredInput,
  CatalogSourceSchema,
  type CatalogSource,
  CatalogEntrySchema,
  type CatalogEntry,
} from "./catalog.js";

export {
  // GPU
  GpuVendorSchema,
  type GpuVendor,
  GpuFactsSchema,
  type GpuFacts,

  // Docker
  DockerFactsSchema,
  type DockerFacts,

  // OS
  OsFactsSchema,
  type OsFacts,

  // Disk
  DiskFactsSchema,
  type DiskFacts,

  // Full RuntimeFacts
  RuntimeFactsSchema,
  type RuntimeFacts,
} from "./runtime-facts.js";

export {
  // Instance config ($APPBAY_HOME/project.yaml — NOT etc/projects/<n>/project.yaml)
  InstanceConfigSchema,
  type InstanceConfig,
  ContainerRuntimeSchema,
  type ContainerRuntime,
  DEFAULT_CONTAINER_RUNTIME,
  IngressProviderSchema,
  type IngressProvider,
  DEFAULT_INGRESS_PROVIDER,
  AcmeDnsProviderSchema,
  type AcmeDnsProvider,
  parseInstanceConfig,
  checkHomeAssertion,
  type HomeMismatch,
  readInstanceConfigText,
  SYSTEM_CONFIG_REL,
  LEGACY_INSTANCE_CONFIG_REL,
} from "./instance.js";


export {
  EdgeRoleSchema,
  EdgePasswordSchema,
  EdgeUserSchema,
  type EdgeUser,
  EdgeIdentityDocumentSchema,
  type EdgeIdentityDocument,
} from "./edge-identities.js";

// Where edge users come from (local JSON store, LDAP, or OIDC)
export {
  EdgeIdentityProviderSchema,
  EdgeIdentityConfigSchema,
  LocalEdgeProviderSchema,
  LdapEdgeProviderSchema,
  OidcEdgeProviderSchema,
  collectEdgeSecretRefs,
  type EdgeIdentityProvider,
  type EdgeIdentityConfig,
} from "./edge-identity-providers.js";
