/**
 * Shared CLI path resolution utilities.
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";

/**
 * Resolve the compose file path for an app.
 * Prefers the rendered compose in rendersDir; falls back to the source compose path.
 */
export async function resolveComposeFile(
  appName: string,
  sourceComposePath: string,
  rendersDir: string,
): Promise<string> {
  const renderedPath = join(rendersDir, appName, "docker-compose.rendered.yml");
  try {
    const info = await stat(renderedPath);
    if (info.isFile()) return renderedPath;
  } catch {
    // Rendered file does not exist; fall back to source.
  }
  return sourceComposePath;
}
