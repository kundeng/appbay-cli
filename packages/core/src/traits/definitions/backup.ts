/**
 * Backup trait definition.
 *
 * System backup (config, state, secrets metadata) and app data backup
 * (volume snapshots). Configurable schedule and retention.
 *
 * At compile time, the trait produces metadata for the scheduler/job queue
 * to pick up at runtime. It does not modify the compose output -- actual
 * backup execution is handled by the job queue.
 *
 * Scope: app-level.
 */

import { BackupTraitSchema } from "../../schemas/appbay-yaml.js";
import type { BackupTrait } from "../../schemas/appbay-yaml.js";
import type {
  TraitDefinition,
  TraitTransformInput,
  TraitTransformOutput,
} from "../types.js";

// ---------------------------------------------------------------------------
// Trait Definition
// ---------------------------------------------------------------------------

export const backupTraitDefinition: TraitDefinition<"backup"> = {
  type: "backup",
  category: "core",
  scope: "app",
  conflictsWith: [],
  description:
    "System backup + app volume snapshots with configurable cron " +
    "schedule and retention policy.",
  schema: BackupTraitSchema,
  transform(input: TraitTransformInput): TraitTransformOutput {
    const props = input.properties as BackupTrait;

    // Backups are handled by the job queue, not compose -- return compose unchanged.
    return {
      compose: input.compose,
      metadata: {
        backup: {
          app: input.app,
          schedule: props.schedule,
          retention: props.retention ?? 7,
          volumes: props.volumes,
        },
      },
    };
  },
};
