/**
 * Pure utility functions for the `appbay validate` command.
 * No external imports — safe to unit-test in a node environment.
 */

/**
 * Format a single Zod issue into a readable string.
 *
 * Examples:
 *   { path: [], message: "Required" }                   → "Required"
 *   { path: ["services", "web"], message: "Invalid" }   → "services.web — Invalid"
 */
export function formatZodIssue(issue: { path: (string | number)[]; message: string }): string {
  const path = issue.path.join(".");
  return path ? `${path} — ${issue.message}` : issue.message;
}

/**
 * Format a discovery error into a single human-readable line.
 *
 * If the error details contain Zod issues (array with path + message fields),
 * the first issue is formatted and a count of remaining issues is appended.
 * Otherwise, falls back to the raw message.
 *
 * The file path is shortened to basename for readability.
 *
 * Examples:
 *   { file: "/apps/myapp/appbay.yaml", message: "parse error" }
 *     → "appbay.yaml: parse error"
 *
 *   { file: "/apps/myapp/appbay.yaml", message: "...", details: [{ path: ["services"], message: "Required" }] }
 *     → "appbay.yaml: services — Required"
 *
 *   With 3 Zod issues: → "appbay.yaml: services — Required (+2 more)"
 */
export function formatErrorMessage(error: {
  file: string;
  message: string;
  details?: unknown;
}): string {
  const fileName = error.file.split("/").pop() ?? error.file;

  if (Array.isArray(error.details) && error.details.length > 0) {
    const firstIssue = error.details[0];
    if (
      firstIssue &&
      typeof firstIssue === "object" &&
      "path" in firstIssue &&
      "message" in firstIssue
    ) {
      const issueStr = formatZodIssue(
        firstIssue as { path: (string | number)[]; message: string },
      );
      const remaining = error.details.length > 1 ? ` (+${error.details.length - 1} more)` : "";
      return `${fileName}: ${issueStr}${remaining}`;
    }
  }

  return `${fileName}: ${error.message}`;
}
