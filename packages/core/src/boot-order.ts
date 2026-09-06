/**
 * System app boot ordering.
 *
 * Defines the fixed deployment sequence for system apps. When `appbay up --all`
 * or `appbay init` deploys everything, system apps are deployed first in this
 * order, with user apps following after all system apps are ready (running, and healthy where a healthcheck exists — see `isReady`).
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
 * The order matters: each app may depend on the ones above it being ready (running, and healthy where a healthcheck exists — see `isReady`).
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

/** What `deployOrder` needs to know about an app. */
export interface OrderableApp {
  appName: string;
  /** The project the app is part of; `default` when it declares none. */
  project: string;
}

/** Project order as `etc/projects.yaml` declares it: `after[p]` are the projects p waits for. */
export type ProjectOrder = Record<string, { after: string[] }>;

export interface DeployOrder<T extends OrderableApp> {
  order: T[];
  /** Direct dependencies: app → the apps that must be ready before it starts. */
  dependsOn: Map<string, Set<string>>;
  /** Why the order cannot be honoured. Non-empty means nothing may start. */
  errors: string[];
}

/**
 * The order apps start in: system apps first in boot order, then every edge that
 * `projects.yaml` declares, expanded to app level. A cycle or an unknown project is an error
 * naming the apps involved, returned before anything runs; there is no weaker order.
 */
export function deployOrder<T extends OrderableApp>(apps: T[], projects: ProjectOrder = {}): DeployOrder<T> {
  const errors: string[] = [];
  const byProject = new Map<string, T[]>();
  for (const app of apps) byProject.set(app.project, [...(byProject.get(app.project) ?? []), app]);

  const dependsOn = new Map<string, Set<string>>(apps.map((a) => [a.appName, new Set<string>()]));
  const systemNames = apps.filter((a) => isSystemApp(a.appName)).map((a) => a.appName);
  for (const app of apps) {
    if (isSystemApp(app.appName)) continue;
    for (const s of systemNames) dependsOn.get(app.appName)!.add(s);
  }
  for (const [name, spec] of Object.entries(projects)) {
    for (const before of spec.after) {
      if (!(before in projects) && !byProject.has(before)) {
        errors.push(`project "${name}" is declared after "${before}", which no app declares and projects.yaml does not define`);
        continue;
      }
      for (const dependent of byProject.get(name) ?? []) {
        for (const dep of byProject.get(before) ?? []) {
          if (dep.appName !== dependent.appName) dependsOn.get(dependent.appName)!.add(dep.appName);
        }
      }
    }
  }

  // Kahn's algorithm; ties keep the input order after system apps in boot order.
  const rank = new Map<string, number>();
  SYSTEM_APP_BOOT_ORDER.forEach((n, i) => rank.set(n, i));
  apps.forEach((a, i) => { if (!rank.has(a.appName)) rank.set(a.appName, SYSTEM_APP_BOOT_ORDER.length + i); });
  const remaining = new Map(apps.map((a) => [a.appName, a]));
  const indegree = new Map(apps.map((a) => [a.appName, dependsOn.get(a.appName)!.size]));
  const order: T[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.keys()].filter((n) => indegree.get(n) === 0).sort((x, y) => rank.get(x)! - rank.get(y)!);
    if (ready.length === 0) {
      errors.push(`start order has a cycle among: ${[...remaining.keys()].join(", ")}`);
      break;
    }
    const next = ready[0]!;
    order.push(remaining.get(next)!);
    remaining.delete(next);
    for (const [n, deps] of dependsOn) if (deps.has(next) && remaining.has(n)) indegree.set(n, indegree.get(n)! - 1);
  }
  return { order, dependsOn, errors };
}

/** Everything that transitively depends on `appName`. */
export function dependentsOf(appName: string, dependsOn: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  const queue = [appName];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const [n, deps] of dependsOn) if (deps.has(cur) && !out.has(n)) { out.add(n); queue.push(n); }
  }
  return out;
}
