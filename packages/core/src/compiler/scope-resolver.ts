/**
 * Scoped variable resolver -- Stage 3 of the compiler pipeline.
 *
 * Parses `${{scope.KEY}}` references and resolves them via prefix-dispatch:
 * `${{project.KEY}}` → project store only, `${{environment.KEY}}` →
 * environment store only, `${{service.KEY}}` → service store only.
 * There is NO cascade fallthrough between stores -- a missing key in the
 * named scope produces an explicit error, not a fallback to a wider scope.
 *
 * Regular `${VAR}` references (Docker Compose style) are left untouched --
 * only the double-brace `${{...}}` syntax is resolved.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Scope values at each level of the hierarchy. */
export interface ScopeValues {
  /**
   * The one value scope a manifest references: the namespace's values, layered as
   * `etc/namespaces/default.yaml` (seeded by init with the system's DOMAIN) under
   * `etc/namespaces/<ns>.yaml`. Referenced as `${{ns:KEY}}`.
   */
  ns: Record<string, string>;
}

/** An error produced when a variable reference cannot be resolved. */
export interface ScopeError {
  /** The full reference string, e.g. `${{project.DOMAIN}}`. */
  reference: string;
  /** The scope name extracted from the reference, e.g. `project`. */
  scope: string;
  /** The key name extracted from the reference, e.g. `DOMAIN`. */
  key: string;
  /** A human-readable error message with actionable guidance. */
  message: string;
}

/** Result of resolving all references in a template string. */
export interface ResolveResult {
  /** The string with all successfully resolved refs replaced. */
  resolved: string;
  /** Any unresolved references encountered during resolution. */
  errors: ScopeError[];
  /** Deprecated spellings that resolved: the pre-S43 dotted `${{project.KEY}}`. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid scope names in resolution priority order (highest first). */
const VALID_SCOPES = ["ns"] as const;
/** Spellings accepted for the one scope. `project` with a DOT is the pre-S43 form, kept for one release. */
const SCOPE_ALIASES: Record<string, ScopeName> = { ns: "ns", namespace: "ns", project: "ns" };

type ScopeName = (typeof VALID_SCOPES)[number];

/**
 * Pattern matching `${{scope.KEY}}` references.
 *
 * Captures:
 *   - Group 1: scope name (e.g. `project`)
 *   - Group 2: key name (e.g. `DOMAIN`)
 *
 * Uses a non-greedy match and requires the closing `}}`.
 * Does NOT match single-brace `${VAR}` references.
 */
const SCOPE_REF_PATTERN = /\$\{\{(\w+)([:.])(\w+)\}\}/g;

// ---------------------------------------------------------------------------
// ScopeResolver
// ---------------------------------------------------------------------------

/**
 * Resolves `${{scope.KEY}}` variable references against a scope chain.
 *
 * The resolver is immutable after construction -- create a new instance for
 * each resolution context (e.g., per-service render pass).
 */
export class ScopeResolver {
  private readonly values: ScopeValues;

  constructor(values: ScopeValues) {
    this.values = values;
  }

  /**
   * Resolve a single `${{scope.KEY}}` reference.
   *
   * If the scope is explicitly named, looks up in that scope only.
   * Returns the resolved string value, or a `ScopeError` if the reference
   * cannot be resolved.
   */
  resolveRef(ref: string): string | ScopeError {
    const match = /^\$\{\{(\w+)([:.])(\w+)\}\}$/.exec(ref);
    if (!match) {
      return {
        reference: ref,
        scope: "unknown",
        key: "unknown",
        message: `Invalid variable reference format: "${ref}". Expected $\{{ns:KEY}}`,
      };
    }

    const spelled = match[1] as string;
    const key = match[3] as string;
    const scope = SCOPE_ALIASES[spelled];
    if (!scope || (match[2] === "." && spelled !== "project")) {
      return {
        reference: ref,
        scope: spelled,
        key,
        message: `Unknown scope "${spelled}" in reference "${ref}". The one scope is ns: write $\{{ns:${key}}}`,
      };
    }

    const scopeValues = this.values[scope as ScopeName];
    const value = scopeValues[key];

    if (value === undefined) {
      return {
        reference: ref,
        scope,
        key,
        message: `Undefined variable "${key}" in scope "${scope}". Check that the key is defined in the ${scope}-level configuration.`,
      };
    }

    return value;
  }

  /**
   * Resolve all `${{scope.KEY}}` references in a template string.
   *
   * Regular `${VAR}` references are left untouched.
   * Multiple references in one string are all resolved.
   */
  resolve(template: string): ResolveResult {
    const errors: ScopeError[] = [];
    const warnings: string[] = [];

    const resolved = template.replace(
      SCOPE_REF_PATTERN,
      (fullMatch, spelled: string, sep: string, key: string) => {
        const scope = SCOPE_ALIASES[spelled];
        if (!scope || (sep === "." && spelled !== "project")) {
          errors.push({
            reference: fullMatch,
            scope: spelled,
            key,
            message: `Unknown scope "${spelled}" in reference "${fullMatch}". The one scope is ns: write $\{{ns:${key}}}`,
          });
          return fullMatch;
        }
        if (sep === ".") warnings.push(`${fullMatch} is the pre-S43 spelling; write $\{{ns:${key}}}. The dotted form is accepted for one release.`);

        const scopeValues = this.values[scope];
        const value = scopeValues[key];

        if (value === undefined) {
          errors.push({
            reference: fullMatch,
            scope,
            key,
            message: `Undefined variable "${key}" in scope "${scope}". Check that the key is defined in the ${scope}-level configuration.`,
          });
          return fullMatch;
        }

        return value;
      },
    );

    return { resolved, errors, warnings };
  }

  /**
   * Resolve all `${{scope.KEY}}` references in all string values of a
   * nested object. Non-string values (numbers, booleans, null) are passed
   * through unchanged. Nested objects and arrays are traversed recursively.
   */
  resolveObject(
    obj: Record<string, unknown>,
  ): { result: Record<string, unknown>; errors: ScopeError[]; warnings: string[] } {
    const errors: ScopeError[] = [];
    const warnings: string[] = [];
    const result = this.resolveValue(obj, errors, warnings) as Record<string, unknown>;
    return { result, errors, warnings };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Recursively resolve references in an arbitrary value.
   */
  private resolveValue(value: unknown, errors: ScopeError[], warnings: string[]): unknown {
    if (typeof value === "string") {
      const { resolved, errors: refErrors, warnings: refWarnings } = this.resolve(value);
      errors.push(...refErrors);
      warnings.push(...refWarnings);
      return resolved;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.resolveValue(item, errors, warnings));
    }

    if (value !== null && typeof value === "object") {
      const resolved: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        resolved[k] = this.resolveValue(v, errors, warnings);
      }
      return resolved;
    }

    // Numbers, booleans, null, undefined -- pass through unchanged.
    return value;
  }
}
