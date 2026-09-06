/**
 * Which services of an app's render `compose pull` can fetch. The compiler strips `build:`
 * from every render and pins `image:` to the tag the build produces, so a render never says
 * which images are built here; the manifest's `builds` and the upstream compose's `build:`
 * do. Asking the registry for a locally built tag fails with a 404 (the caddy edge, every time).
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

type ComposeDoc = { services?: Record<string, { build?: unknown }> };

function servicesOf(path: string): Record<string, { build?: unknown }> {
  try {
    return (parseYaml(readFileSync(path, "utf-8")) as ComposeDoc).services ?? {};
  } catch {
    return {};
  }
}

/** Service names in `renderPath` that are neither built by the manifest nor by the upstream compose. */
export function pullableServices(renderPath: string, upstreamComposePath: string, manifestBuilds: Record<string, unknown> | undefined): string[] {
  const upstream = servicesOf(upstreamComposePath);
  return Object.keys(servicesOf(renderPath)).filter((name) => !(name in (manifestBuilds ?? {})) && upstream[name]?.build === undefined);
}
