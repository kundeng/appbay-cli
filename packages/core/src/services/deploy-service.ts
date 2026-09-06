/**
 * Deploy service — business logic for the shepherd pipeline.
 *
 * Extracts the compile → write → resolve secrets → deploy → post-deploy
 * pipeline from the CLI into reusable typed functions. Both CLI and tRPC
 * call these functions with their own Docker and event-bus adapters.
 *
 * Docker operations are injected as callbacks because CLI uses spawnSync
 * while the web server uses spawnSync with different error handling and
 * event emission. The service module stays Docker-agnostic.
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
// Config files are small and read on paths already synchronous elsewhere in core.
import { readFile, writeFile, mkdir, copyFile, unlink } from "node:fs/promises";
import {
  compile,
  discoverApps,
  type CompileResult,
  type AppCompileResult,
} from "../compiler/index.js";
import {
  resolveSecretsForDeploy,
  resolveWrapperFileSecrets,
  extractSecretRefs,
} from "../secrets/resolve-for-deploy.js";
import { deployOrder, dependentsOf, isSystemApp } from "../boot-order.js";
import { loadProjects } from "../schemas/projects.js";
import { spawnSync } from "node:child_process";
import { containerBin, resolveIngressProvider } from "../runtime/container-runtime.js";
import { findCrashedServices, snapshotContainers, didConverge, isReady, findContainerByLabel, engineObserver, type DockerComposeRunner, type Observer } from "../runtime/observe.js";
import { APP_LABEL, shepherdTarget } from "../compiler/identity.js";
import { loadProjectVars } from "./instance-vars.js";
import { compileInstall } from "./compile-install.js";
import { parseEnvFile } from "./config-service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback for discovering currently running apps. */
/**
 * ⚠️ RETIRED by RFC-001 §5 and kept only as a name for `apps/web`'s status-display helper,
 * which is a different job. `deploy()` no longer takes one: overlays evaluate against the
 * INSTALLED app set, which `compile()` derives itself.
 */
export type RunningAppsDiscoverer = () => Set<string>;

/** Per-app deploy result in the shepherd pipeline. */
export interface AppDeployResult {
  appName: string;
  /**
   * What happened to the DEPLOYMENT. Distinct from `planStatus`, which is what happened to
   * the compiled artifact — see didConverge() and appbay-cli#4.
   */
  status: "deployed" | "unchanged" | "failed";
  isSystem: boolean;
  /** What happened to the COMPILED ARTIFACT. Never a statement about containers. */
  planStatus: "new" | "changed" | "unchanged";
  /**
   * Why the deployment moved: what the converge did to the running containers. `undefined`
   * on the new/changed path (the converge is the point) and when compose could not be
   * asked — in which case the honest answer is that we do not know.
   */
  convergeAction?: "started" | "already-running" | "unknown";
  /** Why the runtime could not be read, when `convergeAction` is "unknown". */
  unknownReason?: string;
  /**
   * The app's container is up but its edge routes did not land — it is running and
   * unreachable. A partial converge, not a total failure (appbay-cli#5).
   */
  containerStartedWithoutRoutes?: boolean;
  error?: string;
  shepherdErrors?: string[];
}

/** Full deploy pipeline result. */
export interface DeployResult {
  apps: AppDeployResult[];
  deployed: number;
  unchanged: number;
  failed: number;
  /**
   * Apps whose own container is running but whose edge routes did NOT land — a PARTIAL
   * converge. Counted separately because neither `deployed` nor `failed` is honest on its
   * own: the app is up, and it is unreachable (appbay-cli#5).
   */
  startedButUnrouted: number;
  compileErrors: Array<{ appName?: string; stage: string; message: string }>;
  warnings?: string[];
}

/** Options for the deploy pipeline. */
export interface DeployOptions {
  appbayHome: string;
  /** Specific apps to deploy. undefined = all. */
  targetApps?: string[];
  /** Deploy only apps in this collection. */
  collection?: string;
  /** Docker compose runner (injected by caller). */
  dockerCompose: DockerComposeRunner;
  /** Running apps discoverer (injected by caller). */
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Re-exported so the public API name does not move. The implementation lives in
 * `instance-vars.ts` because `catalog-service.ts` had its own divergent copy — see that
 * module's header for what the two disagreed about.
 */
export { loadProjectVars };

/**
 * Filter apps by collection membership.
 */
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
 * Write rendered compile output to the renders directory.
 *
 * Auxiliary file paths are resolved relative to APPBAY_HOME.
 */
export async function writeRenderedOutput(
  app: AppCompileResult,
  rendersDir: string,
  appbayHome: string,
): Promise<string> {
  const appDir = join(rendersDir, app.appName);
  await mkdir(appDir, { recursive: true });

  const composePath = join(appDir, "docker-compose.rendered.yml");
  await writeFile(composePath, app.rendered, "utf-8");

  // Write non-edge auxiliary files anchored to APPBAY_HOME. Caddy route and policy files
  // are installed transactionally after the upstream is running; see installCaddyConfig.
  for (const aux of app.auxiliaryFiles) {
    if (isCaddyConfigPath(aux.path)) continue;
    const auxPath = join(appbayHome, aux.path);
    const auxDir = auxPath.substring(0, auxPath.lastIndexOf("/"));
    if (auxDir) {
      await mkdir(auxDir, { recursive: true });
    }
    await writeFile(auxPath, aux.content, "utf-8");
    if (auxPath.endsWith(".sh")) {
      const { chmod } = await import("node:fs/promises");
      await chmod(auxPath, 0o755);
    }
  }

  return composePath;
}

export function isCaddyConfigPath(path: string): boolean {
  return path.startsWith("etc/apps/caddy/config/dynamic/") ||
    path.startsWith("etc/apps/caddy/config/security/policies/");
}

/**
 * The three answers a validator can give. `unavailable` is NOT a kind of `rejected`.
 *
 * 🚨 THESE WERE ONE BOOLEAN AND IT MISDIAGNOSED THE OPERATOR (appbay-cli#5). With the edge
 * not deployed, `no such object: appbay.caddy` — the ENGINE saying the container to exec
 * into does not exist — was returned as `ok: false` and rendered as "Caddy configuration
 * rejected". Caddy was never asked. The message pointed at a perfectly good ingress trait
 * and said nothing about the edge being down, which is the thing that was actually wrong.
 *
 * The rule this project keeps relearning: a check that could not run must not return a
 * verdict. #71 was the same class (a web doctor reporting "Docker daemon is not reachable"
 * on a healthy Podman host).
 */
type CaddyCommandStatus = "ok" | "rejected" | "unavailable";

async function runCaddyCommand(
  appbayHome: string,
  args: string[],
  observer?: Observer,
): Promise<{ status: CaddyCommandStatus; detail: string }> {
  // The edge is found by its label, never by a literal name: the namespace enters every
  // generated name (identity.ts), and a literal went stale the day the system apps were
  // namespaced. A stopped edge is found and reported as not running; a lookup that could
  // not be made is `unavailable` with the runtime's reason, not a verdict about the config.
  const edge = await findContainerByLabel(APP_LABEL, "caddy", { appbayHome, observer });
  if (edge.kind === "unknown") {
    return { status: "unavailable", detail: `could not ask the runtime for the edge (${edge.reason})` };
  }
  if (edge.value === null) {
    return {
      status: "unavailable",
      detail: `no container carries ${APP_LABEL}=caddy — the Caddy edge is not deployed`,
    };
  }
  if (!edge.value.running) {
    return {
      status: "unavailable",
      detail: `the Caddy edge container "${edge.value.name}" exists but is ${edge.value.state}`,
    };
  }
  const result = spawnSync(containerBin(appbayHome), ["exec", edge.value.name, "caddy", ...args], {
    stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8",
  });
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { status: result.status === 0 ? "ok" : "rejected", detail };
}

/**
 * Install manifest-derived Caddy routes/policies, validate the complete imported config,
 * and activate it without restarting Caddy. A failed candidate is rolled back on disk and
 * the last known-good configuration is reloaded.
 */
export async function installCaddyConfig(
  app: Pick<AppCompileResult, "auxiliaryFiles">,
  appbayHome: string,
  observer?: Observer,
): Promise<{ ok: boolean; reason?: "rejected" | "unavailable"; detail?: string }> {
  const files = app.auxiliaryFiles.filter((aux) => isCaddyConfigPath(aux.path));
  if (files.length === 0) return { ok: true };

  const previous = new Map<string, string | null>();
  for (const aux of files) {
    const path = join(appbayHome, aux.path);
    previous.set(path, await readFile(path, "utf-8").catch(() => null));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, aux.content, "utf-8");
  }

  let activation = await runCaddyCommand(appbayHome, [
    "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
  ], observer);
  if (activation.status === "ok") {
    activation = await runCaddyCommand(appbayHome, [
      "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
    ], observer);
    if (activation.status === "ok") return { ok: true };
  }

  for (const [path, content] of previous) {
    if (content === null) await unlink(path).catch(() => undefined);
    else await writeFile(path, content, "utf-8");
  }
  // Only worth attempting when there is a Caddy to reload; on `unavailable` this is a
  // second no-op against a container that does not exist.
  if (activation.status === "rejected") {
    await runCaddyCommand(appbayHome, [
      "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
    ], observer);
  }
  return {
    ok: false,
    reason: activation.status === "unavailable" ? "unavailable" : "rejected",
    detail: activation.detail || "Caddy rejected the generated configuration.",
  };
}

/** The shape every route install answers with, on either provider. */
export interface RouteInstallResult { ok: boolean; reason?: "rejected" | "unavailable"; detail?: string }

/**
 * Install the app's edge route on whichever provider fronts this install, and observe the
 * edge before saying so. Caddy validates and reloads; traefik watches its dynamic directory,
 * so the fragment on disk is the install and the observation is that a running traefik
 * exists to read it. Writing the file with no edge is not a route (review 2026-09-05, F1).
 */
export async function installRoute(
  app: Pick<AppCompileResult, "auxiliaryFiles">,
  appbayHome: string,
  observer: Observer = engineObserver(appbayHome),
): Promise<RouteInstallResult> {
  const provider = resolveIngressProvider(appbayHome);
  if (provider === "caddy") return installCaddyConfig(app, appbayHome, observer);

  const files = app.auxiliaryFiles.filter((aux) => aux.path.startsWith(`etc/apps/${provider}/config/dynamic/`));
  if (files.length === 0) return { ok: true };

  const edge = await observer.findByLabel(APP_LABEL, provider);
  if (edge.kind === "unknown") {
    return { ok: false, reason: "unavailable", detail: `could not ask the runtime for the edge (${edge.reason})` };
  }
  if (edge.value === null) {
    return { ok: false, reason: "unavailable", detail: `no container carries ${APP_LABEL}=${provider} — the ${provider} edge is not deployed` };
  }
  if (!edge.value.running) {
    return { ok: false, reason: "unavailable", detail: `the ${provider} edge container "${edge.value.name}" exists but is ${edge.value.state}` };
  }
  return { ok: true };
}

/**
 * Turn a failed route install into a sentence that names what is actually wrong.
 *
 * ⚠️ ONE HELPER, TWO CALL SITES, ON PURPOSE. `installCaddyConfig` is called from both the
 * new/changed and the unchanged deploy paths, and this repo's dominant defect shape is a
 * fix applied to one of two identical-looking paths (CLAUDE.md records three in one day).
 */
function describeRouteFailure(
  appName: string,
  install: RouteInstallResult,
  provider: string,
): string {
  if (install.reason === "unavailable") {
    return (
      `edge routes NOT installed — the ${provider} edge is not running, so ${appName}'s route ` +
      `was never installed (${install.detail}). ${appName}'s own container is up, but it is ` +
      `not reachable through the edge. Deploy the edge first: \`appbay up ${provider}\`.`
    );
  }
  return `${provider} rejected the generated configuration; generated files rolled back: ${install.detail}`;
}

// ---------------------------------------------------------------------------
// Generic shepherd action runner
// ---------------------------------------------------------------------------

import type { ShepherdAction, ShepherdPhase } from "../traits/types.js";

interface ShepherdRunResult {
  ran: number;
  errors: string[];
}

async function runShepherdActions(
  actions: ShepherdAction[],
  phase: ShepherdPhase,
  ctx: { appName: string; appbayHome: string; secretEnv?: Record<string, string>; observer: Observer },
): Promise<ShepherdRunResult> {
  const phaseActions = actions.filter((a) => a.phase === phase);
  if (phaseActions.length === 0) return { ran: 0, errors: [] };

  const errors: string[] = [];
  let ran = 0;

  for (const action of phaseActions) {
    try {
      if (action.run) {
        await action.run(ctx);
      } else if (action.image) {
        const { runShepherd } = await import("../shepherd/run-shepherd.js");
        // The namespace-sharing target is the app's real container, found by label; the
        // literal `appbay.<app>` was never a container's name (ledger row 24).
        const found = action.share ? await ctx.observer.findByLabel(APP_LABEL, ctx.appName) : null;
        const result = await runShepherd({
          target: found?.kind === "ok" && found.value ? found.value.name : shepherdTarget(ctx.appName),
          image: action.image,
          command: action.command,
          share: action.share,
          mounts: action.mounts,
          env: action.env,
          timeoutMs: action.timeoutMs,
        });
        if (result.exitCode !== 0) {
          errors.push(`${action.label}: exit ${result.exitCode} — ${result.stderr}`);
          continue;
        }
      }
      ran++;
    } catch (err) {
      errors.push(`${action.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ran, errors };
}

// ---------------------------------------------------------------------------
// Deploy pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full shepherd deploy pipeline.
 *
 * Phases:
 *   1. Compile selected apps
 *   2. For new/changed apps: write renders, resolve secrets, docker compose up
 *   3. For unchanged apps: re-inject secrets, ensure containers running
 *   4. Post-deploy hooks
 */
/**
 * The environment a compose child gets for one app: `.env.local` overrides first, resolved
 * secret references over them. One resolver for the two deploy paths and for the edge
 * migration's validate step, which must see the same values the deploy will.
 *
 * @returns the env, or an error naming each reference that could not be resolved.
 */
export async function resolveDeployEnv(
  app: Pick<AppCompileResult, "appName" | "traitMetadata">,
  appsDir: string,
): Promise<{ env: Record<string, string>; error?: string }> {
  let env: Record<string, string> = {};
  const secretRefs = extractSecretRefs(app.traitMetadata);
  if (secretRefs.length > 0) {
    const resolveResult = await resolveSecretsForDeploy(secretRefs);
    if (resolveResult.errors.length > 0) {
      return {
        env,
        error: resolveResult.errors
          .map((e) => {
            const hint = e.error.includes("password")
              ? " Run 'appbay secrets init' to create the vault."
              : e.error.includes("not found") || e.error.includes("No provider")
                ? ` Run 'appbay secrets set ${app.appName}/${e.ref.key} <value>' or 'appbay secrets import ${app.appName}'.`
                : "";
            return `${e.ref.key} (${e.ref.uri}): ${e.error}${hint}`;
          })
          .join("; "),
      };
    }
    env = resolveResult.env;
  }
  // Config overrides go first, vault secrets override them.
  const local = await readFile(join(appsDir, app.appName, ".env.local"), "utf-8").catch(() => null);
  if (local !== null) env = { ...Object.fromEntries(parseEnvFile(local)), ...env };
  return { env };
}

export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const { appbayHome, dockerCompose: runDockerCompose } = options;
  const observer = options.observer ?? engineObserver(appbayHome);
  const appsDir = join(appbayHome, "etc", "apps");
  const rendersDir = join(appbayHome, "var", "lib", "renders");
  const stateDir = join(appbayHome, "var", "lib", "state");

  // Resolve target apps
  let targetApps = options.targetApps;

  if (options.collection) {
    const collectionApps = await filterByCollection(appsDir, options.collection);
    if (collectionApps.length === 0) {
      return {
        apps: [],
        deployed: 0,
        unchanged: 0,
        startedButUnrouted: 0,
        failed: 0,
        compileErrors: [{ stage: "collection", message: `No apps found in collection "${options.collection}"` }],
      };
    }
    targetApps = collectionApps;
  }

  // Pre-compile: ensure .env files exist for all apps
  try {
    const allApps = await discoverApps({ appsDir });
    for (const app of allApps) {
      const envPath = join(appsDir, app.name, ".env");
      await writeFile(envPath, "", { flag: "a" });
    }
  } catch { /* Non-fatal */ }

  // Phase 1: Compile
  const projectVars = options.projectVars ?? await loadProjectVars(appbayHome);

  let compileResult: CompileResult;
  try {
    compileResult = await compileInstall(appbayHome, { apps: targetApps, projectVars, namespace: options.namespace });
  } catch (err) {
    return {
      apps: [],
      deployed: 0,
      unchanged: 0,
      startedButUnrouted: 0,
      failed: 0,
      compileErrors: [{ stage: "compile", message: err instanceof Error ? err.message : String(err) }],
    };
  }

  const result: DeployResult = {
    apps: [],
    deployed: 0,
    unchanged: 0,
    startedButUnrouted: 0,
    failed: 0,
    compileErrors: compileResult.errors.map((e) => ({
      appName: e.appName,
      stage: e.stage,
      message: e.message,
    })),
    warnings: compileResult.warnings.length > 0 ? compileResult.warnings : undefined,
  };

  // 🚨 A DECLARED BACKUP THAT NOTHING RUNS IS WORSE THAN NO BACKUP, because it reads as
  // covered. The backup trait compiles to METADATA ONLY — it returns compose unchanged and
  // leaves execution to the scheduler/job queue in apps/web. On a CLI-only installation
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
    result.warnings = [
      ...(result.warnings ?? []),
      `backup declared but NOT SCHEDULED for: ${backedUp.join(", ")}. The backup trait ` +
        `emits metadata for the job queue in the appbay server, which is not running here — ` +
        `so no backup will be taken. Treat these apps as UNPROTECTED until a backup ` +
        `mechanism exists outside appbay.`,
    ];
  }

  if (compileResult.apps.length === 0) {
    return result;
  }

  // Phase 2-5: Deploy each app in the declared order: system apps first, then the edges
  // etc/projects.yaml declares among projects, expanded to apps. A cycle or an unknown name
  // refuses the whole run before anything starts; there is no weaker order to fall back to.
  const projectsFile = loadProjects(appbayHome);
  if (projectsFile.error) {
    result.compileErrors.push({ stage: "projects", message: projectsFile.error });
    return result;
  }
  const graph = deployOrder(compileResult.apps, projectsFile.config.projects);
  if (graph.errors.length > 0) {
    for (const message of graph.errors) result.compileErrors.push({ stage: "projects", message });
    return result;
  }
  const orderedApps = graph.order;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? projectsFile.config.readiness.timeout_seconds * 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Every failed app goes in here, whatever failed: a dependent must not start over it
  // (review 2026-09-06, F2). The readiness wait below is the only other writer.
  const notReady = new Set<string>();
  const crashGraceMs = options.crashGraceMs ?? 3000;
  // Read once at once and once after the grace: `up -d` returns before a bad config kills the
  // process, and one read at t=0 sees only what has died already.
  const crashCheck = async (project: string) => {
    const first = await findCrashedServices(observer, project);
    if (first.kind === "unknown" || first.value.length > 0 || crashGraceMs <= 0) return first;
    await sleep(crashGraceMs);
    return findCrashedServices(observer, project);
  };

  // 🚨 AN APP WHOSE CONFIGURATION DID NOT COMPILE IS NOT DEPLOYED.
  //
  // This used to deploy anyway. An ingress trait that failed to resolve produced
  // `1 deployed, 1 error(s)` and a RUNNING CONTAINER WITH NO ROUTE — the app was up,
  // looked healthy in every listing, and was unreachable. The operator's next signal would
  // have been a URL that 404s, long after the cause scrolled past.
  //
  // Issue #60 journey 7 states the rule directly: apply FAILS on ingress validation errors.
  // Nothing in any spec sanctions a partial deploy, and the compiler already calls this an
  // error — the deploy proceeding past it was the inconsistency, not the policy.
  //
  // ⚠️ SCOPED TO THE FAILING APP. A broken manifest must not block its neighbours: other
  // apps in the same run still deploy. Failing the whole batch would trade one silent
  // half-configured app for a pile of undeployed healthy ones.
  const appsWithCompileErrors = new Set(
    compileResult.errors.map((e) => e.appName).filter((n): n is string => Boolean(n)),
  );

  for (const app of orderedApps) {
    const planStatus = app.plan.status as "new" | "changed" | "unchanged";
    const isSystem = isSystemApp(app.appName);

    // A dependency that failed or never became ready: skip with the reason, do not start.
    const blockedBy = [...(graph.dependsOn.get(app.appName) ?? [])].filter((d) => notReady.has(d));
    if (blockedBy.length > 0) {
      result.apps.push({
        appName: app.appName, status: "failed", isSystem, planStatus,
        error: `skipped: depends on ${blockedBy.join(", ")}, which did not become ready`,
      });
      result.failed++;
      notReady.add(app.appName);
      continue;
    }
    const appResult: AppDeployResult = {
      appName: app.appName,
      status: "unchanged",
      isSystem,
      planStatus,
    };

    if (appsWithCompileErrors.has(app.appName)) {
      appResult.status = "failed";
      appResult.error =
        "not deployed: its configuration did not compile (see the errors above). " +
        "Deploying it would start a container that cannot serve its declared routes.";
      result.failed += 1;
      result.apps.push(appResult);
      notReady.add(app.appName);
      continue;
    }

    if (planStatus === "new" || planStatus === "changed") {
      // Write rendered output
      let composePath: string;
      try {
        composePath = await writeRenderedOutput(app, rendersDir, appbayHome);
      } catch (err) {
        appResult.status = "failed";
        appResult.error = `Failed to write rendered output: ${err instanceof Error ? err.message : String(err)}`;
        result.apps.push(appResult);
        result.failed++;
        notReady.add(app.appName);
        continue;
      }

      // Copy .env from apps dir to renders dir
      const appEnvSrc = join(appsDir, app.appName, ".env");
      const appEnvDst = join(rendersDir, app.appName, ".env");
      try {
        try {
          await copyFile(appEnvSrc, appEnvDst);
        } catch {
          await writeFile(appEnvDst, "", { flag: "a" });
        }
      } catch { /* ignore */ }

      const resolved = await resolveDeployEnv(app, appsDir);
      if (resolved.error) {
        appResult.status = "failed";
        appResult.error = resolved.error;
        result.apps.push(appResult);
        result.failed++;
        notReady.add(app.appName);
        continue;
      }
      const secretEnv = resolved.env;

      // Resolve wrapper-file secrets (write to shared volume pre-deploy)
      const secretRefs = extractSecretRefs(app.traitMetadata);
      const wrapperRefs = secretRefs.filter((r) => r.injection === "wrapper-file");
      if (wrapperRefs.length > 0) {
        const wrapperResult = await resolveWrapperFileSecrets(
          secretRefs, app.appName,
        );
        if (wrapperResult.errors.length > 0) {
          appResult.status = "failed";
          appResult.error = wrapperResult.errors
            .map((e) => `${e.ref.key}: ${e.error}`)
            .join("; ");
          result.apps.push(appResult);
          result.failed++;
          notReady.add(app.appName);
          continue;
        }
      }

      // Pre-deploy shepherd actions (trait-emitted)
      const shepherdCtx = { appName: app.appName, appbayHome, secretEnv, observer };
      if (app.shepherdActions?.length) {
        const preResult = await runShepherdActions(app.shepherdActions, "pre-deploy", shepherdCtx);
        if (preResult.errors.length > 0) {
          appResult.status = "failed";
          appResult.error = `Pre-deploy shepherd failed: ${preResult.errors.join("; ")}`;
          result.apps.push(appResult);
          result.failed++;
          notReady.add(app.appName);
          continue;
        }
      }

      // Docker compose up
      const dcResult = runDockerCompose(["up", "-d"], composePath, secretEnv);
      if (dcResult.exitCode !== 0) {
        appResult.status = "failed";
        appResult.error = dcResult.output;
        result.apps.push(appResult);
        result.failed++;
        notReady.add(app.appName);
        continue;
      }
      // `up -d` succeeding means "started", not "still running" — see findCrashedServices.
      const crashed = await crashCheck(app.appName);
      if (crashed.kind === "unknown") {
        // Compose could not be asked what it did. Not a deployment, not a failure: say so.
        appResult.status = "unchanged";
        appResult.convergeAction = "unknown";
        appResult.unknownReason = crashed.reason;
        result.apps.push(appResult);
        result.unchanged++;
        continue;
      }
      if (crashed.value.length > 0) {
        appResult.status = "failed";
        appResult.error = `container(s) exited immediately after start: ${crashed.value.join(", ")}`;
        result.apps.push(appResult);
        result.failed++;
        notReady.add(app.appName);
        continue;
      }

      const caddyInstall = await installRoute(app, appbayHome, observer);
      if (!caddyInstall.ok) {
        appResult.status = "failed";
        appResult.error = describeRouteFailure(app.appName, caddyInstall, resolveIngressProvider(appbayHome));
        // The compose converge already succeeded to reach this line, so the app's own
        // container is running while its routes are not installed. Recording it as a plain
        // failure reported a PARTIAL converge as a total one (appbay-cli#5).
        appResult.containerStartedWithoutRoutes = true;
        result.startedButUnrouted++;
        result.apps.push(appResult);
        result.failed++;
        notReady.add(app.appName);
        continue;
      }

      // Post-deploy shepherd actions (trait-emitted) — run alongside legacy hooks
      if (app.shepherdActions?.length) {
        const postResult = await runShepherdActions(app.shepherdActions, "post-deploy", shepherdCtx);
        if (postResult.errors.length > 0) {
          appResult.shepherdErrors = postResult.errors;
        }
      }


      appResult.status = "deployed";
      result.deployed++;
    } else {
      // Unchanged — still write auxiliary files and re-inject secrets
      if (app.auxiliaryFiles.length > 0) {
        for (const aux of app.auxiliaryFiles) {
          if (isCaddyConfigPath(aux.path)) continue;
          const auxPath = join(appbayHome, aux.path);
          const auxDir = auxPath.substring(0, auxPath.lastIndexOf("/"));
          if (auxDir) {
            await mkdir(auxDir, { recursive: true });
          }
          await writeFile(auxPath, aux.content, "utf-8");
        }
      }

      const resolvedUnchanged = await resolveDeployEnv(app, appsDir);
      if (resolvedUnchanged.error) {
        appResult.status = "failed";
        appResult.error = resolvedUnchanged.error;
        result.apps.push(appResult);
        result.failed++;
        notReady.add(app.appName);
        continue;
      }
      const unchangedSecretEnv = resolvedUnchanged.env;

      // Pre-deploy shepherd actions (ensure secrets volumes exist even for unchanged apps)
      const unchangedShepherdCtx = { appName: app.appName, appbayHome, secretEnv: unchangedSecretEnv, observer };
      if (app.shepherdActions?.length) {
        const preResult = await runShepherdActions(app.shepherdActions, "pre-deploy", unchangedShepherdCtx);
        if (preResult.errors.length > 0) {
          appResult.status = "failed";
          appResult.error = `Pre-deploy shepherd failed: ${preResult.errors.join("; ")}`;
          result.apps.push(appResult);
          result.failed++;
          notReady.add(app.appName);
          continue;
        }
      }

      // Ensure container is running
      const existingComposePath = join(rendersDir, app.appName, "docker-compose.rendered.yml");
      if (existsSync(existingComposePath)) {
        // Snapshot BEFORE the converge. An unchanged artifact says nothing about whether
        // the container it describes still exists (appbay-cli#4).
        const before = await snapshotContainers(observer, app.appName);
        const dcResult = runDockerCompose(["up", "-d"], existingComposePath, unchangedSecretEnv);
        if (dcResult.exitCode !== 0) {
          appResult.status = "failed";
          appResult.error = dcResult.output;
          result.apps.push(appResult);
          result.failed++;
          notReady.add(app.appName);
          continue;
        }
        const after = await snapshotContainers(observer, app.appName);
        const converged = didConverge(before, after);
        if (converged.kind === "unknown") {
          appResult.convergeAction = "unknown";
          appResult.unknownReason = converged.reason;
        } else {
          appResult.convergeAction = converged.value ? "started" : "already-running";
        }
        const crashedUnchanged = await crashCheck(app.appName);
        if (crashedUnchanged.kind === "unknown") {
          appResult.convergeAction = "unknown";
          appResult.unknownReason ??= crashedUnchanged.reason;
          result.apps.push(appResult);
          result.unchanged++;
          continue;
        }
        if (crashedUnchanged.value.length > 0) {
          appResult.status = "failed";
          appResult.error = `container(s) exited immediately after start: ${crashedUnchanged.value.join(", ")}`;
          result.apps.push(appResult);
          result.failed++;
          notReady.add(app.appName);
          continue;
        }
      }

      const caddyInstall = await installRoute(app, appbayHome, observer);
      if (!caddyInstall.ok) {
        appResult.status = "failed";
        appResult.error = describeRouteFailure(app.appName, caddyInstall, resolveIngressProvider(appbayHome));
        // The compose converge already succeeded to reach this line, so the app's own
        // container is running while its routes are not installed. Recording it as a plain
        // failure reported a PARTIAL converge as a total one (appbay-cli#5).
        appResult.containerStartedWithoutRoutes = true;
        result.startedButUnrouted++;
        result.apps.push(appResult);
        result.failed++;
        notReady.add(app.appName);
        continue;
      }

      // Count what happened to the DEPLOYMENT, not to the artifact (appbay-cli#4). A
      // converge that created, recreated or started a container is a deployment, however
      // byte-identical the rendered compose was.
      //
      // "unknown" is counted as unchanged rather than deployed: compose could not be
      // asked, and inventing a deployment is the same error in the other direction.
      if (appResult.convergeAction === "started") {
        appResult.status = "deployed";
        result.deployed++;
      } else {
        result.unchanged++;
      }
    }

    // Something starts after this app: wait until it is ready, bounded, and observed.
    if (dependentsOf(app.appName, graph.dependsOn).size > 0) {
      const deadline = Date.now() + readinessTimeoutMs;
      let last = "";
      let ready = false;
      for (;;) {
        const probe = await isReady(observer, app.appName);
        if (probe.kind === "unknown") { last = `could not ask compose (${probe.reason})`; break; }
        if (probe.value.ready) { ready = true; break; }
        last = probe.value.detail;
        if (Date.now() >= deadline) break;
        await sleep(2000);
      }
      if (!ready) {
        if (appResult.status === "deployed") result.deployed--; else result.unchanged--;
        appResult.status = "failed";
        appResult.error = `not ready within ${String(Math.round(readinessTimeoutMs / 1000))}s: ${last}`;
        result.failed++;
        notReady.add(app.appName);
      }
    }

    result.apps.push(appResult);
  }

  return result;
}
