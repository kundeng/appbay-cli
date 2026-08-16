/**
 * System app boot ordering.
 *
 * Defines the fixed deployment sequence for system apps. When `appbay up --all`
 * or `appbay init` deploys everything, system apps are deployed first in this
 * order, with user apps following after all system apps are healthy.
 *
 * The ordering exists because system apps have implicit dependencies:
 *   - traefik: supported ingress-only edge
 *   - caddy: supported integrated ingress and Caddy Security edge
 *
 * This is a CLI concern, not a compiler concern. The compiler treats all apps
 * equally; the CLI shepherds them in the right order.
 */

/**
 * Fixed boot order for system apps. Apps not in this list are treated as
 * user apps and deployed after all system apps.
 *
 * The order matters: each app may depend on the ones above it being healthy.
 */
export const SYSTEM_APP_BOOT_ORDER = [
  // 🚨 BOTH INGRESS PROVIDERS BELONG HERE, AND caddy WAS MISSING. On a
  // `--ingress-provider caddy` installation the proxy was therefore treated as a USER app
  // with no ordered position at all — it could be deployed after the apps that route
  // through it. Listing both is correct rather than picking one: only the installed
  // provider exists in etc/apps, and an absent app is skipped.
  "traefik",
  "caddy",
] as const;

/** Set of system app names for O(1) lookup. */
const SYSTEM_APP_SET = new Set<string>(SYSTEM_APP_BOOT_ORDER);

/**
 * Check whether an app name is a system app (has a fixed boot position).
 */
export function isSystemApp(appName: string): boolean {
  return SYSTEM_APP_SET.has(appName);
}

/**
 * Partition a list of app names into system apps (ordered) and user apps.
 *
 * System apps are returned in boot order (regardless of input order).
 * User apps are returned in their original order.
 *
 * @param appNames - App names to partition.
 * @returns `{ system, user }` — system apps in boot order, user apps in original order.
 */
export function partitionByBootOrder(appNames: string[]): {
  system: string[];
  user: string[];
} {
  const userApps: string[] = [];
  const systemAppsPresent = new Set<string>();

  for (const name of appNames) {
    if (SYSTEM_APP_SET.has(name)) {
      systemAppsPresent.add(name);
    } else {
      userApps.push(name);
    }
  }

  // Return system apps in fixed boot order (only those that are present).
  const systemApps = SYSTEM_APP_BOOT_ORDER.filter((name) =>
    systemAppsPresent.has(name),
  );

  return { system: [...systemApps], user: userApps };
}

/**
 * Sort compiled app results into deployment order: system apps first
 * (in boot order), then user apps.
 *
 * @param apps - Compiled app results (with `.appName` property).
 * @returns New array sorted by deployment order.
 */
export function sortByDeployOrder<T extends { appName: string }>(
  apps: T[],
): T[] {
  const byName = new Map(apps.map((a) => [a.appName, a]));
  const result: T[] = [];

  // System apps in boot order.
  for (const name of SYSTEM_APP_BOOT_ORDER) {
    const app = byName.get(name);
    if (app) {
      result.push(app);
      byName.delete(name);
    }
  }

  // Remaining (user) apps in original order.
  for (const app of apps) {
    if (byName.has(app.appName)) {
      result.push(app);
    }
  }

  return result;
}
