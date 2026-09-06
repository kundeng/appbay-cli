/**
 * Which services of an app's render `compose pull` can fetch. The compiler strips `build:`
 * from every render. A manifest `builds.<service>` entry is consulted only for a service
 * whose upstream compose has `build:`; when it applies, the render's `image:` is pinned to
 * the build's tag, and when it is gated off (`when:`) the compose's own registry image
 * stays. So: with a manifest entry, the service is built here iff the rendered image is
 * the entry's image; without one, iff the upstream declares `build:`. Asking the registry
 * for a locally built tag fails with a 404 (the caddy edge, every time).
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

type ComposeDoc = { services?: Record<string, { image?: unknown; build?: unknown }> };
type Builds = Record<string, { image?: unknown; [key: string]: unknown } | undefined>;

function servicesOf(path: string): NonNullable<ComposeDoc["services"]> | null {
  try {
    return (parseYaml(readFileSync(path, "utf-8")) as ComposeDoc).services ?? {};
  } catch {
    return null;
  }
}

/** Service names in `renderPath` whose image comes from a registry; null when a compose file could not be read. */
export function pullableServices(renderPath: string, upstreamComposePath: string, manifestBuilds: Builds | undefined): string[] | null {
  const upstream = servicesOf(upstreamComposePath);
  const rendered = servicesOf(renderPath);
  if (upstream === null || rendered === null) return null;
  return Object.entries(rendered)
    .filter(([name, svc]) => {
      const built = manifestBuilds?.[name];
      if (built !== undefined) return svc.image !== built.image;
      return upstream[name]?.build === undefined;
    })
    .map(([name]) => name);
}
