/**
 * `etc/projects.yaml`: the start order among projects.
 *
 * A project is the operator's unit of composition: the apps that declare `project: <name>`
 * run together. This file adds `after:` edges among projects; the deploy expands them to
 * edges between apps and refuses a cycle or an unknown name before starting anything.
 * Absent file: no order beyond system apps first. (Compose's own "project" is one app.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const PROJECTS_FILE_REL = "etc/projects.yaml";

export const ProjectsFileSchema = z.object({
  projects: z
    .record(
      z.object({
        description: z.string().optional(),
        /** Projects whose apps must all be ready before any app of this one starts. */
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

export type ProjectsFile = z.infer<typeof ProjectsFileSchema>;

/** The parsed file, or the defaults when it is absent; a present file that does not parse is an error. */
export function loadProjects(appbayHome: string): { config: ProjectsFile; source: "file" | "absent"; error?: string } {
  const path = join(appbayHome, PROJECTS_FILE_REL);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { config: ProjectsFileSchema.parse({}), source: "absent" };
    return { config: ProjectsFileSchema.parse({}), source: "absent", error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = ProjectsFileSchema.safeParse(parseYaml(text) ?? {});
  if (!parsed.success) {
    return { config: ProjectsFileSchema.parse({}), source: "file", error: `${PROJECTS_FILE_REL}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  return { config: parsed.data, source: "file" };
}
