/**
 * Which services of an app's render `compose pull` can fetch. The compiler strips `build:`
 * from every render; when a manifest build applies it pins the service's `image:` to the
 * tag the build produces, and when the build is gated off (`when:`) the compose's own
 * registry image stays. So a service is built here iff its rendered image is the manifest
 * build's image, or the upstream compose declares `build:` for it. Asking the registry for
 * a locally built tag fails with a 404 (the caddy edge, every time).
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

type ComposeDoc = { services?: Record<string, { image?: unknown; build?: unknown }> };
type Builds = Record<string, { image?: unknown; [key: string]: unknown } | undefined>;

function servicesOf(path: string): NonNullable<ComposeDoc["services"]> {
  try {
    return (parseYaml(readFileSync(path, "utf-8")) as ComposeDoc).services ?? {};
  } catch {
    return {};
  }
}

/** Service names in `renderPath` whose image comes from a registry. */
export function pullableServices(renderPath: string, upstreamComposePath: string, manifestBuilds: Builds | undefined): string[] {
  const upstream = servicesOf(upstreamComposePath);
  return Object.entries(servicesOf(renderPath))
    .filter(([name, svc]) => {
      const built = manifestBuilds?.[name];
      const pinnedToBuild = built !== undefined && typeof built.image === "string" && svc.image === built.image;
      return !pinnedToBuild && upstream[name]?.build === undefined;
    })
    .map(([name]) => name);
}
