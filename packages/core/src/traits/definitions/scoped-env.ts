/**
 * Scoped-env trait definition.
 *
 * Injects environment variables into a compose service, with values that may
 * contain `${{scope.KEY}}` references. Those references are left as-is here
 * and resolved later by the ScopeResolver stage of the compiler pipeline.
 *
 * Scope: app-level.
 */

import type { ScopedEnvTrait } from "../../schemas/appbay-yaml.js";
import { ScopedEnvTraitSchema } from "../../schemas/appbay-yaml.js";
import type { TraitDefinition } from "../types.js";

export const scopedEnvTraitDefinition: TraitDefinition<"scoped-env"> = {
  type: "scoped-env",
  category: "core",
  scope: "app",
  conflictsWith: [],
  description:
    "Scoped environment variable injection via ${{scope.KEY}} syntax. " +
    "Writes resolved values to the rendered .env file.",
  schema: ScopedEnvTraitSchema,
  transform(input) {
    const props = input.properties as ScopedEnvTrait;
    const compose = structuredClone(input.compose);
    const services = compose.services as
      | Record<string, Record<string, unknown>>
      | undefined;
    const targetService = input.service;

    if (targetService && services && services[targetService]) {
      const svc = services[targetService];
      const existing = Array.isArray(svc.environment)
        ? svc.environment
        : [];
      const newVars = Object.entries(props.vars).map(
        ([k, v]) => `${k}=${v}`,
      );
      svc.environment = [...existing, ...newVars];
    }

    return { compose };
  },
};
