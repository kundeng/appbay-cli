/**
 * Deploy service: `appbay up`, `appbay apply` and the edge migration call `deploy()` with
 * their own compose runner and observer.
 *
 * The deploy is a chain of converges per app (deploy/converges.ts), walked in the order
 * `deployOrder` gives with one skip rule (deploy/converge.ts), and the report is folded
 * from the verdicts afterwards (deploy/report.ts). Nothing here counts anything.
 */

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { discoverApps, type CompileResult } from "../compiler/index.js";
import { deployOrder, dependentsOf } from "../boot-order.js";
import { loadProjects } from "../schemas/projects.js";
import { engineObserver, type DockerComposeRunner, type Observer } from "../runtime/observe.js";
import { loadProjectVars } from "./instance-vars.js";
import { compileInstall } from "./compile-install.js";
import { runConverges, type DeployContext } from "./deploy/converge.js";
import { planConverges } from "./deploy/converges.js";
import { emptyDeployResult, foldDeployResult, type DeployResult, type PlanStatus } from "./deploy/report.js";

export type { AppDeployResult, DeployResult, PlanStatus } from "./deploy/report.js";
export { writeRenderedOutput, resolveDeployEnv } from "./deploy/converges.js";
export { isCaddyConfigPath, installCaddyConfig, installRoute, type RouteInstallResult } from "./deploy/route.js";
/**
 * Re-exported so the public API name does not move. The implementation lives in
 * `instance-vars.ts` because `catalog-service.ts` had its own divergent copy.
 */
export { loadProjectVars };

/** Options for the deploy pipeline. */
export interface DeployOptions {
  appbayHome: string;
  /** Specific apps to deploy. undefined = all. */
  targetApps?: string[];
  /** Deploy only apps in this collection. */
  collection?: string;
  /** Docker compose runner (injected by caller). */
  dockerCompose: DockerComposeRunner;
  /** Base namespace values from the system (DOMAIN); `etc/namespaces/*.yaml` layer over them. */
  projectVars?: Record<string, string>;
  /** The namespace for every app whose manifest pins none (`--namespace`). */
  namespace?: string;
  /** Overrides `collections.yaml`'s readiness timeout; tests use it. */
  readinessTimeoutMs?: number;
  /** Test seam for the readiness poll's pause. */
  sleep?: (ms: number) => Promise<void>;
  /** How the deploy observes the runtime; defaults to the API over the socket. */
  observer?: Observer;
  /** How long after `up -d` the crash check looks again; a service that dies a moment after start is caught. */
  crashGraceMs?: number;
}

/** Filter apps by collection membership. */
export async function filterByCollection(
  appsDir: string,
  collectionName: string,
): Promise<string[]> {
  const discovered = await discoverApps({ appsDir });
  return discovered
    .filter((app) => app.appbayConfig?.collection?.includes(collectionName))
    .map((app) => app.name);
}

/**
 * Compile the selected apps, order them, run every app's chain of converges, and fold the
 * report. A projects file that cannot be honoured (a cycle, an unknown name) refuses the
 * whole run before anything starts; there is no weaker order to fall back to.
 */
export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const { appbayHome } = options;
  const appsDir = join(appbayHome, "etc", "apps");
  const rendersDir = join(appbayHome, "var", "lib", "renders");

  let targetApps = options.targetApps;
  if (options.collection) {
    const collectionApps = await filterByCollection(appsDir, options.collection);
    if (collectionApps.length === 0) {
      return emptyDeployResult([{ stage: "collection", message: `No apps found in collection "${options.collection}"` }]);
    }
    targetApps = collectionApps;
  }

  // Every app has a `.env`, empty if it declares nothing: compose and the render copy read it.
  try {
    for (const app of await discoverApps({ appsDir })) {
      await writeFile(join(appsDir, app.name, ".env"), "", { flag: "a" });
    }
  } catch { /* Non-fatal */ }

  const projectVars = options.projectVars ?? await loadProjectVars(appbayHome);
  let compileResult: CompileResult;
  try {
    compileResult = await compileInstall(appbayHome, { apps: targetApps, projectVars, namespace: options.namespace });
  } catch (err) {
    return emptyDeployResult([{ stage: "compile", message: err instanceof Error ? err.message : String(err) }]);
  }

  const compileErrors = compileResult.errors.map((e) => ({ appName: e.appName, stage: e.stage, message: e.message }));
  const warnings = [...compileResult.warnings];

  // 🚨 A DECLARED BACKUP THAT NOTHING RUNS IS WORSE THAN NO BACKUP, because it reads as
  // covered. The backup trait compiles to METADATA ONLY — it returns compose unchanged and
  // leaves execution to the appbay server's job queue, which is not in this tree. On a CLI-only installation
  // that queue is not deployed, so `schedule` and `retention` are recorded, shown, and
  // never acted on. Nothing errors; the app simply is not backed up.
  //
  // ⚠️ This does NOT implement backup, and deliberately so — that is a separate decision.
  // It converts a silent gap into a stated one, which is the part that cannot wait: the
  // failure mode is discovering it when you need a restore.
  const backedUp = compileResult.apps
    .filter((a) => (a.traitMetadata as Record<string, unknown> | undefined)?.backup)
    .map((a) => a.appName);
  if (backedUp.length > 0) {
    warnings.push(
      `backup declared but NOT SCHEDULED for: ${backedUp.join(", ")}. The backup trait ` +
        `emits metadata for the job queue in the appbay server, which is not running here — ` +
        `so no backup will be taken. Treat these apps as UNPROTECTED until a backup ` +
        `mechanism exists outside appbay.`,
    );
  }

  if (compileResult.apps.length === 0) return emptyDeployResult(compileErrors, warnings);

  const projectsFile = loadProjects(appbayHome);
  if (projectsFile.error) {
    return emptyDeployResult([...compileErrors, { stage: "projects", message: projectsFile.error }], warnings);
  }
  const graph = deployOrder(compileResult.apps, projectsFile.config.projects);
  if (graph.errors.length > 0) {
    return emptyDeployResult([...compileErrors, ...graph.errors.map((message) => ({ stage: "projects", message }))], warnings);
  }

  const appsWithCompileErrors = new Set(compileResult.errors.map((e) => e.appName).filter((n): n is string => Boolean(n)));
  const chain = planConverges(graph.order.map((app) => ({
    app,
    compileFailed: appsWithCompileErrors.has(app.appName),
    dependsOn: graph.dependsOn.get(app.appName) ?? new Set<string>(),
    waitReady: dependentsOf(app.appName, graph.dependsOn).size > 0,
  })));
  const ctx: DeployContext = {
    appbayHome, appsDir, rendersDir,
    observer: options.observer ?? engineObserver(appbayHome),
    dockerCompose: options.dockerCompose,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    crashGraceMs: options.crashGraceMs ?? 3000,
    readinessTimeoutMs: options.readinessTimeoutMs ?? projectsFile.config.readiness.timeout_seconds * 1000,
  };
  const verdicts = await runConverges(chain, ctx);
  return foldDeployResult(
    graph.order.map((a) => ({ appName: a.appName, planStatus: a.plan.status as PlanStatus })),
    verdicts,
    { compileErrors, warnings: warnings.length > 0 ? warnings : undefined },
  );
}
