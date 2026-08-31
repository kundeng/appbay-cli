/**
 * Conditional overlay resolver -- evaluates `when` clauses against the set of
 * INSTALLED apps and merges matching overlay fragments into compose
 * service definitions.
 *
 * Two clause shapes are supported:
 *   - AND (array): `when: [ollama, whisper]` -- all listed apps must be active.
 *   - OR (object): `when: { any: [tts, stt] }` -- at least one must be active.
 *
 * See agents.md "Conditional overlays" and design.md "Overlay Section" for
 * the canonical reference.
 */

import type { WhenClause } from "../schemas/appbay-yaml.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input to the overlay selection phase. */
export interface OverlayInput {
  overlays: Array<{
    when: WhenClause;
    services: Record<string, Record<string, unknown>>;
  }>;
  /**
   * Names of INSTALLED apps — the full declared set, not what happens to be running.
   * RFC-001 §5: `when: [a, b]` asserts a and b are installed, which is a fact about
   * desired state, knowable at compile time and needing no container runtime.
   */
  installedApps: Set<string>;
}

/** An overlay whose `when` clause was satisfied. */
export interface ActiveOverlay {
  when: WhenClause;
  services: Record<string, Record<string, unknown>>;
}

/** An overlay whose `when` clause was NOT satisfied, with a reason. */
export interface InactiveOverlay {
  when: WhenClause;
  reason: string;
}

/** Result of evaluating all overlays against the installed app set. */
export interface OverlayResult {
  activeOverlays: ActiveOverlay[];
  inactiveOverlays: InactiveOverlay[];
}

// ---------------------------------------------------------------------------
// Clause evaluation
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `clause` is an AND clause (plain string array).
 */
function isAndClause(clause: WhenClause): clause is string[] {
  return Array.isArray(clause);
}

/**
 * Evaluate a `when` clause against the installed app set.
 *
 * @returns `null` when the clause is satisfied, or a human-readable reason
 *          string when it is not.
 */
function evaluateClause(
  clause: WhenClause,
  installedApps: Set<string>,
): string | null {
  if (isAndClause(clause)) {
    // AND -- every listed app must be installed.
    const missing = clause.filter((app) => !installedApps.has(app));
    if (missing.length > 0) {
      return `AND clause not met: app(s) not installed: ${missing.join(", ")}`;
    }
    return null;
  }

  // OR -- at least one of the listed apps must be installed.
  const { any: apps } = clause;
  const found = apps.some((app) => installedApps.has(app));
  if (!found) {
    return `OR clause not met: none of ${apps.join(", ")} are installed`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// selectActiveOverlays
// ---------------------------------------------------------------------------

/**
 * Partition overlays into active (clause satisfied) and inactive (clause not
 * satisfied) sets.
 */
export function selectActiveOverlays(input: OverlayInput): OverlayResult {
  const activeOverlays: ActiveOverlay[] = [];
  const inactiveOverlays: InactiveOverlay[] = [];

  for (const overlay of input.overlays) {
    const reason = evaluateClause(overlay.when, input.installedApps);
    if (reason === null) {
      activeOverlays.push({
        when: overlay.when,
        services: overlay.services,
      });
    } else {
      inactiveOverlays.push({
        when: overlay.when,
        reason,
      });
    }
  }

  return { activeOverlays, inactiveOverlays };
}

// ---------------------------------------------------------------------------
// Deep merge helpers
// ---------------------------------------------------------------------------

/** Keys whose values are arrays and should be merged by appending. */
const APPEND_ARRAY_KEYS = new Set(["environment", "volumes", "ports"]);

/** Keys whose values are objects and should be shallow-merged. */
const MERGE_OBJECT_KEYS = new Set(["labels", "depends_on"]);

/**
 * Determine whether a value is a plain object (not an array, null, or other
 * non-record type).
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge a single overlay service fragment into a base service definition.
 *
 * Merge rules:
 *   - `environment`, `volumes`, `ports` arrays: append overlay entries.
 *   - `labels`, `depends_on` objects: shallow merge (overlay wins on conflict).
 *   - Scalar values: overlay overrides base.
 *   - Unknown keys: overlay value used as-is.
 */
function mergeServiceFragment(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = result[key];

    if (APPEND_ARRAY_KEYS.has(key)) {
      // Array append -- coerce both sides to arrays for safety.
      const baseArr = Array.isArray(baseValue) ? baseValue : [];
      const overlayArr = Array.isArray(overlayValue) ? overlayValue : [];
      const merged = [...baseArr, ...overlayArr];
      // Deduplicate environment entries: overlay value wins on key collision
      if (key === "environment") {
        const seen = new Map<string, number>();
        for (let i = merged.length - 1; i >= 0; i--) {
          const entry = merged[i];
          if (typeof entry !== "string") continue;
          const eq = entry.indexOf("=");
          const envKey = eq > 0 ? entry.substring(0, eq) : entry;
          if (seen.has(envKey)) {
            merged.splice(i, 1);
          } else {
            seen.set(envKey, i);
          }
        }
      }
      result[key] = merged;
    } else if (MERGE_OBJECT_KEYS.has(key)) {
      // Object merge -- overlay values override base on key collision.
      const baseObj = isPlainObject(baseValue) ? baseValue : {};
      const overlayObj = isPlainObject(overlayValue) ? overlayValue : {};
      result[key] = { ...baseObj, ...overlayObj };
    } else if (isPlainObject(baseValue) && isPlainObject(overlayValue)) {
      // Recursively merge nested objects that are not in the special sets.
      result[key] = mergeServiceFragment(baseValue, overlayValue);
    } else {
      // Scalar or unknown -- overlay wins.
      result[key] = overlayValue;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// mergeOverlays
// ---------------------------------------------------------------------------

/**
 * Deep-merge an ordered list of overlay service fragments into a base compose
 * services object.  Overlays are applied left-to-right (first overlay wins on
 * equal-priority keys, but later overlays can override scalars).
 *
 * If an overlay targets a service that does not exist in `baseServices`, a new
 * service entry is created from the overlay fragment.
 */
export function mergeOverlays(
  baseServices: Record<string, Record<string, unknown>>,
  overlays: Array<{ services: Record<string, Record<string, unknown>> }>,
): Record<string, Record<string, unknown>> {
  let result: Record<string, Record<string, unknown>> = { ...baseServices };

  // Deep-copy base service entries so we never mutate the caller's objects.
  for (const svcName of Object.keys(result)) {
    result[svcName] = { ...result[svcName] };
  }

  for (const overlay of overlays) {
    for (const [svcName, fragment] of Object.entries(overlay.services)) {
      if (result[svcName]) {
        result[svcName] = mergeServiceFragment(
          result[svcName],
          fragment,
        ) as Record<string, unknown>;
      } else {
        // New service introduced by the overlay.
        result[svcName] = { ...fragment };
      }
    }
  }

  return result;
}
