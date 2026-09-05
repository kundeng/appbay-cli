/**
 * `etc/collections.yaml`: the collections an install declares as ordered stacks.
 *
 * A collection is a name apps put in their `collection:` list. This file adds a start order
 * among collections; the deploy expands it to edges between apps and refuses a cycle or an
 * unknown name before starting anything. Absent file: no order beyond system apps first.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const COLLECTIONS_FILE_REL = "etc/collections.yaml";

export const CollectionsFileSchema = z.object({
  collections: z
    .record(
      z.object({
        description: z.string().optional(),
        /** Collections whose apps must all be ready before any app of this one starts. */
        after: z.array(z.string()).default([]),
      }),
    )
    .default({}),
  readiness: z
    .object({
      /** How long the deploy waits for an app to become ready before failing it and skipping its dependents. */
      timeout_seconds: z.number().int().positive().default(90),
    })
    .default({}),
});

export type CollectionsFile = z.infer<typeof CollectionsFileSchema>;

/** The parsed file, or the defaults when it is absent; a present file that does not parse is an error. */
export function loadCollections(appbayHome: string): { config: CollectionsFile; source: "file" | "absent"; error?: string } {
  const path = join(appbayHome, COLLECTIONS_FILE_REL);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { config: CollectionsFileSchema.parse({}), source: "absent" };
    return { config: CollectionsFileSchema.parse({}), source: "absent", error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = CollectionsFileSchema.safeParse(parseYaml(text) ?? {});
  if (!parsed.success) {
    return { config: CollectionsFileSchema.parse({}), source: "file", error: `${COLLECTIONS_FILE_REL}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  return { config: parsed.data, source: "file" };
}
