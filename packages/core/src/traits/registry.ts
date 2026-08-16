/**
 * Trait registry -- manages trait definitions, enforces OAM rules, and
 * provides lookup.
 *
 * OAM rules enforced:
 *  1. One configuration per trait type per service (validated via `validateAssignment`).
 *  2. Traits applied in declaration order (enforced by the trait engine, not the registry).
 *  3. `conflictsWith` declared on definitions (checked via `detectConflicts`).
 *
 * v1: all traits are compiled in (static). The registry is populated at module
 * load time via `registerCoreTraits()`.
 */

import type {
  TraitDefinition,
  TraitScope,
  ConflictResult,
  ValidationResult,
} from "./types.js";

export class TraitRegistry {
  /** Internal map of trait type name to definition. */
  private readonly definitions = new Map<string, TraitDefinition>();

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a trait definition. Throws if a trait with the same type is
   * already registered.
   */
  register(definition: TraitDefinition): void {
    if (this.definitions.has(definition.type)) {
      throw new Error(
        `Trait type "${definition.type}" is already registered. ` +
          "Each trait type may only be registered once.",
      );
    }
    this.definitions.set(definition.type, definition);
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /** Look up a trait definition by type name. Returns undefined if not found. */
  get(type: string): TraitDefinition | undefined {
    return this.definitions.get(type);
  }

  /** Return all registered trait definitions. */
  all(): TraitDefinition[] {
    return Array.from(this.definitions.values());
  }

  // -------------------------------------------------------------------------
  // Conflict Detection
  // -------------------------------------------------------------------------

  /**
   * Detect conflicts among a set of trait types. Checks the `conflictsWith`
   * declarations on each registered trait definition.
   *
   * Returns an array of conflict results (empty if no conflicts).
   */
  detectConflicts(traitTypes: string[]): ConflictResult[] {
    const conflicts: ConflictResult[] = [];
    const typeSet = new Set(traitTypes);

    for (const type of traitTypes) {
      const definition = this.definitions.get(type);
      if (!definition) continue;

      for (const conflicting of definition.conflictsWith) {
        if (typeSet.has(conflicting)) {
          // Avoid reporting the same pair twice (A conflicts B = B conflicts A).
          const alreadyReported = conflicts.some(
            (c) =>
              (c.traitA === conflicting && c.traitB === type) ||
              (c.traitA === type && c.traitB === conflicting),
          );
          if (!alreadyReported) {
            conflicts.push({
              traitA: type,
              traitB: conflicting,
              message:
                `Trait "${type}" conflicts with "${conflicting}". ` +
                "These traits cannot be applied to the same scope.",
            });
          }
        }
      }
    }

    return conflicts;
  }

  // -------------------------------------------------------------------------
  // Assignment Validation
  // -------------------------------------------------------------------------

  /**
   * Validate that a trait type can be assigned to a given scope, considering
   * the traits already assigned.
   *
   * Checks:
   *  - The trait type is registered.
   *  - The trait scope matches the assignment scope.
   *  - The trait type is not already in `existingTraits` (OAM one-per-type rule).
   *  - No conflicts with existing traits.
   */
  validateAssignment(
    traitType: string,
    scope: TraitScope,
    existingTraits: string[],
  ): ValidationResult {
    const errors: string[] = [];

    const definition = this.definitions.get(traitType);
    if (!definition) {
      errors.push(`Unknown trait type "${traitType}".`);
      return { valid: false, errors };
    }

    // Check scope match.
    if (definition.scope !== scope) {
      errors.push(
        `Trait "${traitType}" has scope "${definition.scope}" ` +
          `but was assigned at "${scope}" scope.`,
      );
    }

    // OAM rule: one configuration per trait type per service.
    if (existingTraits.includes(traitType)) {
      errors.push(
        `Duplicate trait type "${traitType}" on the same scope. ` +
          "OAM rule: one configuration per trait type per service.",
      );
    }

    // Check conflicts with existing traits.
    const conflictsWithExisting = this.detectConflicts([
      traitType,
      ...existingTraits,
    ]);
    for (const conflict of conflictsWithExisting) {
      // Only report conflicts that involve the new trait type.
      if (conflict.traitA === traitType || conflict.traitB === traitType) {
        errors.push(conflict.message);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
