/**
 * Zod schemas for project.yaml and environment.yaml configuration files.
 *
 * These files live under `$APPBAY_HOME/etc/projects/<name>/`:
 *   - `project.yaml`                   -- project-level vars and defaults
 *   - `environments/<env>.yaml`         -- environment-level vars and overrides
 *
 * See design.md "Scope Resolution" and agents.md "Scope resolution" for
 * the canonical resolution order: service > environment > project.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Project Config (etc/projects/<name>/project.yaml)
// ---------------------------------------------------------------------------

export const ProjectConfigSchema = z.object({
  /** Human-readable project name (matches the directory name). */
  name: z.string(),

  /** Key-value variables available at the project scope. */
  vars: z.record(z.string()).optional(),

  /** Default values for project-wide settings. */
  defaults: z
    .object({
      /** Default environment when none is specified. */
      environment: z.string().optional(),
      /** Default operator for app placement. */
      operator: z.string().optional(),
      /** Default secret provider URI scheme. */
      secret_provider: z.string().optional(),
    })
    .optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// ---------------------------------------------------------------------------
// Environment Config (etc/projects/<name>/environments/<env>.yaml)
// ---------------------------------------------------------------------------

export const EnvironmentConfigSchema = z.object({
  /** Environment name (matches the file name without extension). */
  name: z.string(),

  /** Key-value variables available at the environment scope. */
  vars: z.record(z.string()).optional(),

  /** Variable overrides that take precedence over project-level vars. */
  overrides: z.record(z.string()).optional(),
});

export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;
