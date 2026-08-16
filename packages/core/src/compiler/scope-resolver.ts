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
  project: Record<string, string>;
  environment: Record<string, string>;
  service: Record<string, string>;
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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid scope names in resolution priority order (highest first). */
const VALID_SCOPES = ["service", "environment", "project"] as const;

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
const SCOPE_REF_PATTERN = /\$\{\{(\w+)\.(\w+)\}\}/g;

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
    const match = /^\$\{\{(\w+)\.(\w+)\}\}$/.exec(ref);
    if (!match) {
      return {
        reference: ref,
        scope: "unknown",
        key: "unknown",
        message: `Invalid variable reference format: "${ref}". Expected $\{{scope.KEY}} where scope is one of: ${VALID_SCOPES.join(", ")}`,
      };
    }

    const scope = match[1] as string;
    const key = match[2] as string;

    if (!VALID_SCOPES.includes(scope as ScopeName)) {
      return {
        reference: ref,
        scope,
        key,
        message: `Unknown scope "${scope}" in reference "${ref}". Valid scopes are: ${VALID_SCOPES.join(", ")}`,
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

    const resolved = template.replace(
      SCOPE_REF_PATTERN,
      (fullMatch, scope: string, key: string) => {
        if (!VALID_SCOPES.includes(scope as ScopeName)) {
          errors.push({
            reference: fullMatch,
            scope,
            key,
            message: `Unknown scope "${scope}" in reference "${fullMatch}". Valid scopes are: ${VALID_SCOPES.join(", ")}`,
          });
          return fullMatch;
        }

        const scopeValues = this.values[scope as ScopeName];
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

    return { resolved, errors };
  }

  /**
   * Resolve all `${{scope.KEY}}` references in all string values of a
   * nested object. Non-string values (numbers, booleans, null) are passed
   * through unchanged. Nested objects and arrays are traversed recursively.
   */
  resolveObject(
    obj: Record<string, unknown>,
  ): { result: Record<string, unknown>; errors: ScopeError[] } {
    const errors: ScopeError[] = [];
    const result = this.resolveValue(obj, errors) as Record<string, unknown>;
    return { result, errors };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Recursively resolve references in an arbitrary value.
   */
  private resolveValue(value: unknown, errors: ScopeError[]): unknown {
    if (typeof value === "string") {
      const { resolved, errors: refErrors } = this.resolve(value);
      errors.push(...refErrors);
      return resolved;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.resolveValue(item, errors));
    }

    if (value !== null && typeof value === "object") {
      const resolved: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        resolved[k] = this.resolveValue(v, errors);
      }
      return resolved;
    }

    // Numbers, booleans, null, undefined -- pass through unchanged.
    return value;
  }
}
