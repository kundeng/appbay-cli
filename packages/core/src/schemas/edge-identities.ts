/** Typed subset of the Caddy Security local identity database owned by AppBay. */
import { z } from "zod";

export const EdgeRoleSchema = z.object({ name: z.string().min(1), organization: z.string().min(1) });
export const EdgePasswordSchema = z.object({
  purpose: z.literal("generic"), algorithm: z.literal("bcrypt"),
  hash: z.string().regex(/^\$2[aby]\$\d{2}\$.+/), cost: z.number().int().min(4).max(31),
  expired_at: z.string(), created_at: z.string(), disabled_at: z.string(),
});
const EdgeEmailSchema = z.object({ address: z.string().email(), domain: z.string().min(1) });
export const EdgeUserSchema = z.object({
  id: z.string().uuid(), username: z.string().min(3).max(50),
  email_address: EdgeEmailSchema, email_addresses: z.array(EdgeEmailSchema),
  passwords: z.array(EdgePasswordSchema).min(1), created: z.string(),
  last_modified: z.string(), roles: z.array(EdgeRoleSchema),
});
export type EdgeUser = z.infer<typeof EdgeUserSchema>;
export const EdgeIdentityDocumentSchema = z.object({
  version: z.string().min(1), policy: z.record(z.unknown()),
  revision: z.number().int().nonnegative(), last_modified: z.string(), loaded_at: z.string(),
  users: z.array(EdgeUserSchema),
}).passthrough();
export type EdgeIdentityDocument = z.infer<typeof EdgeIdentityDocumentSchema>;
