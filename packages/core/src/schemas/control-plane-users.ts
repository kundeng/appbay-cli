/** Typed durable identity for the AppBay control plane. */

import { z } from "zod";

export const ControlPlaneUserStatusSchema = z.enum(["active", "disabled"]);
export type ControlPlaneUserStatus = z.infer<typeof ControlPlaneUserStatusSchema>;

/** Current AppBay hashes are a 16-byte hex salt plus a 64-byte scrypt hash. */
export const ControlPlanePasswordHashSchema = z
  .string()
  .regex(
    /^[0-9a-f]{32}:[0-9a-f]{128}$/,
    "expected a scrypt hash in <32 hex salt>:<128 hex hash> format",
  );

export const ControlPlaneUserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(3).max(50),
  passwordHash: ControlPlanePasswordHashSchema,
  status: ControlPlaneUserStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ControlPlaneUser = z.infer<typeof ControlPlaneUserSchema>;

export const ControlPlaneUsersDocumentSchema = z
  .object({
    version: z.literal(1),
    users: z.array(ControlPlaneUserSchema),
  })
  .superRefine((document, ctx) => {
    const ids = new Set<string>();
    const usernames = new Set<string>();
    for (const [index, user] of document.users.entries()) {
      if (ids.has(user.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["users", index, "id"],
          message: `duplicate user id: ${user.id}`,
        });
      }
      if (usernames.has(user.username)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["users", index, "username"],
          message: `duplicate username: ${user.username}`,
        });
      }
      ids.add(user.id);
      usernames.add(user.username);
    }
  });
export type ControlPlaneUsersDocument = z.infer<typeof ControlPlaneUsersDocumentSchema>;
