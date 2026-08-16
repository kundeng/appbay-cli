/**
 * Pure utility functions for the `appbay url` command.
 * No external imports — safe to unit-test in a node environment.
 */

/**
 * Extract the host port number string from a Docker Compose port specification.
 *
 * Handles:
 *   - Simple mapping: "8080:80" → "8080"
 *   - Container-only: "3000"   → "3000"
 *   - Env-var with default: "${PORT:-3000}:80" → "3000"
 *   - Env-var standalone: "${PORT:-3000}" → "3000"
 *
 * The Docker Compose port spec format is: [host_ip:][host_port:]container_port.
 * This function first expands `${VAR:-default}` patterns (replacing them with
 * the default value) before splitting on colons, which avoids the ambiguity
 * introduced by the colon inside the `:-` separator.
 *
 * Note: `${VAR}` without a default is left as-is (the raw expression is returned).
 */
export function extractHostPort(portSpec: string): string {
  // Expand ${VAR:-default} → default before splitting on ':'
  // This must happen before split(":") to avoid the ":-" colon corrupting the result.
  const expanded = portSpec.replace(/\$\{[^}]*:-([^}]*)\}/g, "$1");
  return expanded.split(":")[0] ?? expanded;
}
