/**
 * GPU trait definition.
 *
 * Selects GPU passthrough variant (nvidia/cdi/rocm) based on runtime facts
 * and generates the appropriate compose fragment for device access.
 *
 * Scope: service-level.
 */

import { GpuTraitSchema } from "../../schemas/appbay-yaml.js";
import type { GpuTrait } from "../../schemas/appbay-yaml.js";
import type { GpuFacts } from "../../schemas/runtime-facts.js";
import type {
  TraitDefinition,
  TraitTransformInput,
  TraitTransformOutput,
} from "../types.js";

// ---------------------------------------------------------------------------
// Variant resolution
// ---------------------------------------------------------------------------

type GpuVariant = "nvidia" | "cdi" | "rocm";

/**
 * Resolve the effective GPU variant from explicit config or runtime facts.
 * Throws if no GPU is available and no explicit variant is specified.
 */
export function resolveVariant(
  explicitVariant: GpuVariant | undefined,
  gpuFacts: GpuFacts,
): GpuVariant {
  if (explicitVariant) {
    return explicitVariant;
  }

  // Auto-detect from runtime facts
  if (!gpuFacts.available) {
    throw new Error(
      "GPU trait: no GPU detected on the host and no explicit variant specified.",
    );
  }

  if (gpuFacts.cdiSupported) {
    return "cdi";
  }
  if (gpuFacts.vendor === "nvidia") {
    return "nvidia";
  }
  if (gpuFacts.vendor === "amd") {
    return "rocm";
  }

  throw new Error(
    `GPU trait: unable to auto-detect variant for vendor "${gpuFacts.vendor ?? "unknown"}".`,
  );
}

// ---------------------------------------------------------------------------
// Per-variant compose mutations
// ---------------------------------------------------------------------------

/**
 * Apply NVIDIA Docker GPU runtime configuration.
 *
 * Produces:
 * ```yaml
 * deploy:
 *   resources:
 *     reservations:
 *       devices:
 *         - driver: nvidia
 *           count: <count>
 *           capabilities: [gpu]
 * ```
 */
function applyNvidia(
  svc: Record<string, unknown>,
  count: number,
): void {
  const deviceCount = count === -1 ? "all" : count;
  const deploy = (svc.deploy ?? {}) as Record<string, unknown>;
  const resources = (deploy.resources ?? {}) as Record<string, unknown>;
  const reservations = (resources.reservations ?? {}) as Record<
    string,
    unknown
  >;
  const devices = (reservations.devices ?? []) as unknown[];

  devices.push({
    driver: "nvidia",
    count: deviceCount,
    capabilities: ["gpu"],
  });

  reservations.devices = devices;
  resources.reservations = reservations;
  deploy.resources = resources;
  svc.deploy = deploy;
}

/**
 * Apply CDI (Container Device Interface) configuration.
 *
 * Produces:
 * ```yaml
 * devices:
 *   - nvidia.com/gpu=<device>
 * ```
 */
function applyCdi(
  svc: Record<string, unknown>,
  count: number,
  explicitDevices: string[] | undefined,
  factsDevices: string[] | undefined,
): void {
  const existing = (svc.devices ?? []) as string[];

  if (explicitDevices && explicitDevices.length > 0) {
    // Use explicit device names from trait config
    for (const dev of explicitDevices) {
      existing.push(`nvidia.com/gpu=${dev}`);
    }
  } else if (factsDevices && factsDevices.length > 0) {
    // ⚠️ ALREADY QUALIFIED — DO NOT PREFIX AGAIN. `detectGpu` emits facts devices as full CDI
    // names (`nvidia.com/gpu=0`), while the explicit-config branch above takes bare device
    // ids. Prefixing both produced `nvidia.com/gpu=nvidia.com/gpu=0`, which compose accepts
    // and the runtime cannot resolve — a rendered file that looks fine and fails at start.
    const selected =
      count === -1 ? factsDevices : factsDevices.slice(0, count);
    for (const dev of selected) {
      existing.push(dev.startsWith("nvidia.com/gpu=") ? dev : `nvidia.com/gpu=${dev}`);
    }
  } else {
    // Fallback: request all GPUs
    existing.push("nvidia.com/gpu=all");
  }

  svc.devices = existing;
}

/**
 * Apply ROCm (AMD GPU) configuration.
 *
 * Produces:
 * ```yaml
 * devices:
 *   - /dev/kfd
 *   - /dev/dri
 * group_add:
 *   - video
 *   - render
 * ```
 */
function applyRocm(svc: Record<string, unknown>): void {
  const devices = (svc.devices ?? []) as string[];
  devices.push("/dev/kfd", "/dev/dri");
  svc.devices = devices;

  const groups = (svc.group_add ?? []) as string[];
  groups.push("video", "render");
  svc.group_add = groups;
}

// ---------------------------------------------------------------------------
// Trait definition
// ---------------------------------------------------------------------------

export const gpuTraitDefinition: TraitDefinition<"gpu"> = {
  type: "gpu",
  category: "core",
  scope: "service",
  conflictsWith: [],
  description:
    "GPU device passthrough (nvidia/cdi/rocm) based on runtime facts " +
    "reported by the app operator.",
  schema: GpuTraitSchema,
  transform(input: TraitTransformInput): TraitTransformOutput {
    const props = input.properties as GpuTrait;
    const gpuFacts = input.context.runtimeFacts.gpu;
    const serviceName = input.service;

    if (!serviceName) {
      throw new Error("GPU trait requires a target service name.");
    }

    const variant = resolveVariant(props.variant, gpuFacts);
    const count = props.count ?? 1;

    // Deep-clone compose to avoid mutating the original
    const compose = structuredClone(input.compose);

    const services = compose.services as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!services || !services[serviceName]) {
      throw new Error(
        `GPU trait: target service "${serviceName}" not found in compose.`,
      );
    }

    const svc = services[serviceName];

    switch (variant) {
      case "nvidia":
        applyNvidia(svc, count);
        break;
      case "cdi":
        applyCdi(svc, count, props.devices, gpuFacts.devices);
        break;
      case "rocm":
        applyRocm(svc);
        break;
    }

    return { compose };
  },
};
