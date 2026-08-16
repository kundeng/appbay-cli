import { z } from "zod";

// ---------------------------------------------------------------------------
// Required Input (drives CLI prompts and UI wizard forms)
// ---------------------------------------------------------------------------

export const RequiredInputSchema = z.object({
  name: z.string(),
  description: z.string(),
  type: z.enum(["string", "number", "boolean", "secret", "path"]),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  auto_generate: z.boolean().optional(),
});

export type RequiredInput = z.infer<typeof RequiredInputSchema>;

// ---------------------------------------------------------------------------
// Source provenance
// ---------------------------------------------------------------------------

export const CatalogSourceSchema = z.object({
  type: z.enum(["git", "local"]),
  url: z.string().optional(),
  path: z.string().optional(),
  ref: z.string().optional(),
});

export type CatalogSource = z.infer<typeof CatalogSourceSchema>;

// ---------------------------------------------------------------------------
// Full catalog.yaml schema
// ---------------------------------------------------------------------------

export const CatalogEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string().optional(),
  category: z.string(),
  tags: z.array(z.string()).default([]),
  source: CatalogSourceSchema.optional(),
  readiness: z.enum(["raw", "augmented", "native"]).default("raw"),
  required_inputs: z.array(RequiredInputSchema).default([]),
  traits_summary: z.array(z.string()).default([]),
  maintainer: z.string().default("community"),
});

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
