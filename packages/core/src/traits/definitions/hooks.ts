/**
 * Hooks trait definition.
 *
 * Lifecycle patterns that add auxiliary containers or config objects to an
 * app's compose file. Three patterns are supported:
 *
 *   1. **init** -- One-shot container that runs before the target service.
 *      Uses `depends_on` with `condition: service_completed_successfully`.
 *
 *   2. **sidecar** -- Long-running companion service with shared volumes.
 *      Runs alongside the target service for the lifetime of the app.
 *
 *   3. **config** -- Compose `configs` with inline `content` (Compose
 *      v2.23.1+). Mounts generated config files into the target service
 *      without creating additional containers.
 *
 * Design constraints:
 *   - Never rewrite entrypoints (Compose-native mechanisms only).
 *   - Hook service names are namespaced to avoid collisions:
 *     `<app>-<hookType>-hook` (or `<app>-<service>-<hookType>-hook`).
 *
 * Scope: service-level.
 */

import { HooksTraitSchema } from "../../schemas/appbay-yaml.js";
import type { HooksTrait } from "../../schemas/appbay-yaml.js";
import type {
  TraitDefinition,
  TraitTransformInput,
  TraitTransformOutput,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a namespaced hook service name to prevent collisions across apps.
 */

/**
 * Namespace a hook's named-volume references the way the upstream transform already does.
 *
 * 🚨 WITHOUT THIS THE HOOK MOUNTS THE WRONG THING, OR NOTHING. Stage 2a prefixes named
 * volumes with the app name for namespace isolation, but hook services are emitted later
 * and used to carry the author's raw reference. So the project defined
 * `homeassistant_ha-config` while the hook asked for `ha-config`, and compose rejected the
 * WHOLE project:
 *
 *     service "homeassistant-init-hook" refers to undefined volume ha-config
 *
 * ⚠️ That error was once "fixed" in the manifest by deleting the `:/config` mount path.
 * That does silence compose — a bare `ha-config` is an ANONYMOUS volume, not a named-volume
 * reference — but the hook then mounts nothing, chowns its own ephemeral directory, and
 * exits 0. A green no-op is worse than the error it replaced, because nothing points at it.
 *
 * Only NAMED volumes are rewritten. A bind mount (absolute or relative) is a host path and
 * must be left exactly as written.
 */
function namespaceHookVolumes(volumes: string[], app: string): string[] {
  return volumes.map((entry) => {
    // Bind mounts: `/abs/path:...` or `./rel/path:...` — host paths, never namespaced.
    if (entry.startsWith("/") || entry.startsWith(".") || entry.startsWith("~")) return entry;

    const [name, ...rest] = entry.split(":");
    if (!name) return entry;

    // Already namespaced — do not double-prefix on a recompile.
    if (name.startsWith(`${app}_`)) return entry;

    return [`${app}_${name}`, ...rest].join(":");
  });
}

export function hookServiceName(
  app: string,
  service: string | undefined,
  pattern: string,
): string {
  const base = service ? `${app}-${service}` : app;
  return `${base}-${pattern}-hook`;
}

/**
 * Build a namespaced config name for the `config` pattern.
 */
export function hookConfigName(
  app: string,
  service: string | undefined,
): string {
  const base = service ? `${app}-${service}` : app;
  return `${base}-hook-config`;
}

// ---------------------------------------------------------------------------
// Pattern implementations
// ---------------------------------------------------------------------------

/**
 * Init pattern: create a one-shot service that runs to completion before
 * the target service starts.
 *
 * The target service gets a `depends_on` entry with
 * `condition: service_completed_successfully`, ensuring the init hook
 * finishes before the main service starts.
 */
function applyInitPattern(
  compose: Record<string, unknown>,
  app: string,
  service: string | undefined,
  props: HooksTrait,
): Record<string, unknown> {
  const result = { ...compose };
  const services = { ...((result.services ?? {}) as Record<string, unknown>) };

  const initName = hookServiceName(app, service, "init");

  // Create the init (one-shot) service definition.
  const initService: Record<string, unknown> = {
    image: props.image ?? "busybox:latest",
    restart: "no",
  };
  if (props.command) {
    initService.command = props.command;
  }
  if (props.volumes && props.volumes.length > 0) {
    initService.volumes = namespaceHookVolumes(props.volumes, app);
  }

  services[initName] = initService;

  // Wire the target service to depend on the init hook completing.
  if (service) {
    const targetSvc = {
      ...((services[service] as Record<string, unknown>) ?? {}),
    };
    const dependsOn = {
      ...((targetSvc.depends_on as Record<string, unknown>) ?? {}),
    };
    dependsOn[initName] = { condition: "service_completed_successfully" };
    targetSvc.depends_on = dependsOn;
    services[service] = targetSvc;
  }

  result.services = services;
  return result;
}

/**
 * Sidecar pattern: create a long-running companion service that shares
 * volumes with the target service.
 *
 * The sidecar runs alongside the target service for the full lifetime of
 * the app deployment.
 */
function applySidecarPattern(
  compose: Record<string, unknown>,
  app: string,
  service: string | undefined,
  props: HooksTrait,
): Record<string, unknown> {
  const result = { ...compose };
  const services = { ...((result.services ?? {}) as Record<string, unknown>) };

  const sidecarName = hookServiceName(app, service, "sidecar");

  const targetService = service ?? Object.keys(services)[0];

  // Create the sidecar service definition.
  const sidecarService: Record<string, unknown> = {
    image: props.image ?? "busybox:latest",
    restart: "unless-stopped",
  };
  if (props.command) {
    sidecarService.command = props.command;
  }
  if (props.volumes && props.volumes.length > 0) {
    sidecarService.volumes = namespaceHookVolumes(props.volumes, app);
  }

  // Namespace sharing (D1, D2, D3)
  if (props.share) {
    if (props.share.network && targetService) {
      sidecarService.network_mode = `service:${targetService}`;
      delete sidecarService.ports;
    }
    if (props.share.pid && targetService) {
      sidecarService.pid = `service:${targetService}`;
    }
    if (props.share.ipc && targetService) {
      sidecarService.ipc = `service:${targetService}`;
    }
    // Auto-add depends_on for shared-namespace sidecars (D3)
    if ((props.share.network || props.share.pid || props.share.ipc) && targetService) {
      sidecarService.depends_on = {
        [targetService]: { condition: "service_started" },
      };
    }
  }

  services[sidecarName] = sidecarService;
  result.services = services;
  return result;
}

/**
 * Config pattern: use Compose `configs` with inline `content` to mount
 * generated configuration into the target service.
 *
 * Requires Docker Compose v2.23.1+ for the `content` field.
 * Does NOT create additional containers.
 */
function applyConfigPattern(
  compose: Record<string, unknown>,
  app: string,
  service: string | undefined,
  props: HooksTrait,
): Record<string, unknown> {
  const result = { ...compose };
  const configName = hookConfigName(app, service);

  // Add the config to the top-level `configs` section with inline content.
  const configs = {
    ...((result.configs as Record<string, unknown>) ?? {}),
  };
  configs[configName] = {
    content: props.content ?? "",
  };
  result.configs = configs;

  // Mount the config into the target service.
  if (service) {
    const services = {
      ...((result.services ?? {}) as Record<string, unknown>),
    };
    const targetSvc = {
      ...((services[service] as Record<string, unknown>) ?? {}),
    };
    const svcConfigs = Array.isArray(targetSvc.configs)
      ? [...targetSvc.configs]
      : [];
    svcConfigs.push({
      source: configName,
      target: `/${configName}`,
    });
    targetSvc.configs = svcConfigs;
    services[service] = targetSvc;
    result.services = services;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Trait Definition
// ---------------------------------------------------------------------------

export const hooksTraitDefinition: TraitDefinition<"hooks"> = {
  type: "hooks",
  category: "core",
  scope: "service",
  conflictsWith: [],
  description:
    "Lifecycle hook patterns: init (one-shot container with " +
    "depends_on: service_completed_successfully), sidecar (long-running " +
    "companion with shared volumes), config (Compose configs with inline " +
    "content). Never rewrites entrypoints.",
  schema: HooksTraitSchema,
  transform(input: TraitTransformInput): TraitTransformOutput {
    const props = input.properties as HooksTrait;

    let compose: Record<string, unknown>;

    switch (props.pattern) {
      case "init":
        compose = applyInitPattern(
          input.compose,
          input.app,
          input.service,
          props,
        );
        break;
      case "sidecar":
        compose = applySidecarPattern(
          input.compose,
          input.app,
          input.service,
          props,
        );
        break;
      case "config":
        compose = applyConfigPattern(
          input.compose,
          input.app,
          input.service,
          props,
        );
        break;
    }

    return { compose };
  },
};
