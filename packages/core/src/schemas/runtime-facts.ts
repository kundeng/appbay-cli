/**
 * Zod schema for RuntimeFacts -- capability data reported by app operators.
 *
 * RuntimeFacts captures what an app operator discovers about its host environment:
 *   - GPU availability and vendor details
 *   - Docker and Docker Compose versions
 *   - Operating system information
 *   - Disk capacity
 *   - Operator identity
 *
 * Used by the compiler pipeline (CompileContext.runtimeFacts) to make trait
 * decisions at compile time (e.g., GPU trait selects nvidia/cdi/rocm variant
 * based on reported GPU facts).
 *
 * See design.md "Data Models > Runtime Facts Schema" for the canonical reference.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// GPU Facts
// ---------------------------------------------------------------------------

/** GPU vendor reported by the operator's detection probes. */
export const GpuVendorSchema = z.enum(["nvidia", "amd", "intel", "none"]);

export type GpuVendor = z.infer<typeof GpuVendorSchema>;

export const GpuFactsSchema = z.object({
  /** Whether any GPU is detected on the host. */
  available: z.boolean(),
  /** GPU vendor. Optional when `available` is false. */
  vendor: GpuVendorSchema.optional(),
  /** Whether the NVIDIA Container Device Interface is supported. */
  cdiSupported: z.boolean().default(false),
  /** List of detected GPU device identifiers (e.g., CDI device names). */
  devices: z.array(z.string()).optional(),
});

export type GpuFacts = z.infer<typeof GpuFactsSchema>;

// ---------------------------------------------------------------------------
// Docker Facts
// ---------------------------------------------------------------------------

export const DockerFactsSchema = z.object({
  /** Docker Engine version string (e.g., "24.0.7"). */
  version: z.string(),
  /** Docker Compose version string (e.g., "2.23.3"). */
  composeVersion: z.string(),
  /** Path to the Docker socket (e.g., "/var/run/docker.sock"). */
  socketPath: z.string(),
});

export type DockerFacts = z.infer<typeof DockerFactsSchema>;

// ---------------------------------------------------------------------------
// OS Facts
// ---------------------------------------------------------------------------

export const OsFactsSchema = z.object({
  /** Operating system platform (e.g., "linux", "darwin"). */
  platform: z.string(),
  /** CPU architecture (e.g., "x64", "arm64"). */
  arch: z.string(),
  /** OS version string (e.g., "6.5.0-35-generic"). */
  version: z.string(),
});

export type OsFacts = z.infer<typeof OsFactsSchema>;

// ---------------------------------------------------------------------------
// Disk Facts
// ---------------------------------------------------------------------------

export const DiskFactsSchema = z.object({
  /** Available disk space in gigabytes. */
  availableGb: z.number(),
  /** Total disk space in gigabytes. */
  totalGb: z.number(),
});

export type DiskFacts = z.infer<typeof DiskFactsSchema>;

// ---------------------------------------------------------------------------
// Full RuntimeFacts Schema
// ---------------------------------------------------------------------------

export const RuntimeFactsSchema = z.object({
  gpu: GpuFactsSchema,
  docker: DockerFactsSchema,
  os: OsFactsSchema,
  disk: DiskFactsSchema,
  /** Unique identifier for the app operator reporting these facts. */
  operatorId: z.string(),
});

export type RuntimeFacts = z.infer<typeof RuntimeFactsSchema>;
