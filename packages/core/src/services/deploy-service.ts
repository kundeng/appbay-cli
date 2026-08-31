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
import { readFileSync } from "node:fs";
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
import { detectRuntimeFacts } from "../runtime/facts.js";
import { sortByDeployOrder, isSystemApp } from "../boot-order.js";
import { spawnSync } from "node:child_process";
import { containerBin } from "../runtime/container-runtime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of running docker compose for a single app. */
export interface DockerComposeResult {
  exitCode: number;
  output: string;
}

/** Callback for running docker compose commands. */
export type DockerComposeRunner = (
  subArgs: string[],
  composePath: string,
  env?: Record<string, string>,
) => DockerComposeResult;

/**
 * After `compose up -d`, confirm the containers are actually still running.
 *
 * 🚨 `compose up -d` EXITS 0 WHEN IT STARTS A CONTAINER — it does not wait to see whether
 * the container stays up. A service that launches and immediately dies (bad config, missing
 * mount, unparseable file) therefore produced:
 *
 *     appbay up crasher   ->  "1 deployed, 0 error(s)", exit 0
 *     podman ps           ->  nothing running, Exited (1)
 *
 * Measured, not theorised. That is the same shape as trusting a 2xx: the command was
 * accepted, which is not the same as the world being in the state you asked for.
 *
 * ⚠️ A ZERO exit is NOT treated as failure. Compose services legitimately run to completion
 * — init containers, migrations, one-shot jobs — and failing those would be worse than the
 * bug being fixed. Only a NON-ZERO exit counts, because that is a container saying it could
 * not do its job.
 *
 * @returns a human-readable description of the dead services, or null when all is well.
 */
/** One container row, normalised across the two compose providers. */
interface ComposePsRow {
  name: string;
  id: string;
  service: string;
  state: string;
  exitCode: number;
}

/**
 * List the containers compose knows about for one project, on EITHER provider.
 *
 * 🚨 `ps -a` IS REJECTED BY podman-compose, AND THAT MADE THE CRASH DETECTOR VACUOUS.
 * Measured on appbay-rhel (podman-compose 1.5.0):
 *
 *     $ podman compose ps -a --format json
 *     podman-compose: error: unrecognized arguments: -a       (exit 2)
 *
 * Every caller treated a non-zero exit as "cannot inspect — do not invent a failure" and
 * returned null, so on every Podman host findCrashedServices() reported "nothing crashed"
 * without ever looking. The `-a` was added to Docker's form precisely so exited containers
 * would be listed; podman-compose's plain `ps` already lists them (verified: a stopped
 * container appears with State "exited", ExitCode 137).
 *
 * The two providers also disagree on field names — Docker emits `Name`/`ID`, podman-compose
 * emits `Names` (an ARRAY) and `Id`, and carries the service in a compose label.
 *
 * @returns normalised rows, or null when neither form could be run.
 */
function composePs(
  runDockerCompose: DockerComposeRunner,
  composePath: string,
  env: Record<string, string>,
): ComposePsRow[] | null {
  let ps = runDockerCompose(["ps", "-a", "--format", "json"], composePath, env);
  if (ps.exitCode !== 0) {
    // podman-compose: no `-a`, and none needed.
    ps = runDockerCompose(["ps", "--format", "json"], composePath, env);
  }
  if (ps.exitCode !== 0) return null; // Cannot inspect — do not invent a verdict.

  const rows: ComposePsRow[] = [];
  for (const row of parseComposePsJson(ps.output)) {
    const r = row as {
      ID?: string; Id?: string;
      Name?: string; Names?: string[];
      Service?: string; State?: string; ExitCode?: number;
      Labels?: Record<string, string>;
    };
    const name = r.Name ?? (Array.isArray(r.Names) ? r.Names[0] : undefined) ?? r.Service;
    if (!name) continue;
    rows.push({
      name,
      id: r.ID ?? r.Id ?? "",
      service: r.Service ?? r.Labels?.["com.docker.compose.service"] ?? name,
      state: (r.State ?? "").toLowerCase(),
      exitCode: typeof r.ExitCode === "number" ? r.ExitCode : 0,
    });
  }
  return rows;
}

/**
 * Pull the container rows out of a `compose ps --format json` run, on either provider.
 *
 * 🚨 THE TWO PROVIDERS DO NOT EMIT THE SAME DOCUMENT, AND ASSUMING THEY DID MADE THIS
 * CHECK SILENTLY EMPTY ON PODMAN. Docker Compose emits NDJSON — one object per line.
 * podman-compose PRETTY-PRINTS a single array across many lines, behind a banner:
 *
 *     >>>> Executing external compose provider "/usr/sbin/podman-compose" ... <<<<
 *     [
 *       {
 *         "Names": [ "psprobe_probe_1" ],
 *
 * Parsing that line-by-line yields nothing that is valid JSON, so the row list came back
 * EMPTY rather than failing — and an empty list reads as "no containers", which is a
 * verdict, not the absence of one. That is how the converge check reported
 * "already running" for a container it had just created (appbay-cli#4, caught on the
 * SECOND runtime after passing 10/10 on Docker).
 */
function parseComposePsJson(output: string): unknown[] {
  // Whole-document first, starting at the first structural character so any provider
  // banner ahead of it is skipped.
  const start = output.search(/[[{]/);
  if (start >= 0) {
    try {
      const parsed: unknown = JSON.parse(output.slice(start));
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Not one document — fall through to NDJSON.
    }
  }

  const rows: unknown[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      for (const row of Array.isArray(parsed) ? parsed : [parsed]) rows.push(row);
    } catch {
      continue;
    }
  }
  return rows;
}

function findCrashedServices(
  runDockerCompose: DockerComposeRunner,
  composePath: string,
  env: Record<string, string>,
): string | null {
  const rows = composePs(runDockerCompose, composePath, env);
  if (rows === null) return null; // Cannot inspect — do not invent a failure.

  const dead: string[] = [];
  for (const r of rows) {
    if (r.state === "exited" && r.exitCode !== 0) {
      dead.push(`${r.service} exited ${String(r.exitCode)}`);
    }
  }
  return dead.length > 0 ? dead.join(", ") : null;
}

/** One container's identity and run state, as compose reports it. */
interface ContainerState {
  id: string;
  running: boolean;
}

/**
 * Snapshot the containers compose knows about for one project, keyed by container name.
 *
 * @returns the snapshot, or null when compose could not be asked — the caller must treat
 *          null as "unknown", never as "nothing running".
 */
function snapshotContainers(
  runDockerCompose: DockerComposeRunner,
  composePath: string,
  env: Record<string, string>,
): Map<string, ContainerState> | null {
  // Stopped containers MUST be in this list: a container about to be STARTED is exactly a
  // stopped one, and missing it would make every start look like "already running".
  const rows = composePs(runDockerCompose, composePath, env);
  if (rows === null) return null;

  const snapshot = new Map<string, ContainerState>();
  for (const r of rows) {
    snapshot.set(r.name, { id: r.id, running: r.state === "running" });
  }
  return snapshot;
}

/**
 * Did `compose up -d` actually change the running world?
 *
 * 🚨 THIS EXISTS BECAUSE `[UNCHANGED]` IS A VERDICT ABOUT THE COMPILED ARTIFACT AND WAS
 * BEING SUMMED AS THOUGH IT WERE A VERDICT ABOUT THE DEPLOYMENT (appbay-cli#4). The two
 * questions disagree exactly when it matters most: the rendered compose is byte-identical
 * to last time, and the container it describes is gone. Measured with the container
 * removed first, `appbay up whoami` created and started it and then reported
 * `0 deployed, 1 unchanged`.
 *
 * A converge counts as a deployment when a container is CREATED, RECREATED (same name, new
 * id) or STARTED (same id, was not running). "Already running, nothing to do" is the only
 * case that is genuinely unchanged.
 *
 * @returns true/false when both snapshots are known, and null when either could not be
 *          taken — an unknown must not be reported as either verdict.
 */
function didConverge(
  before: Map<string, ContainerState> | null,
  after: Map<string, ContainerState> | null,
): boolean | null {
  if (!before || !after) return null;
  for (const [name, now] of after) {
    const was = before.get(name);
    if (!was) return true;                        // created
    if (was.id !== now.id) return true;           // recreated under the same name
    if (!was.running && now.running) return true; // started
  }
  return false;
}

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
  /** Project-level variables (e.g., { DOMAIN: "example.com" }). */
  projectVars?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Load project.yaml from APPBAY_HOME and return project-level variables.
 */
export async function loadProjectVars(appbayHome: string): Promise<Record<string, string>> {
  try {
    const text =
      readInstanceConfigText(appbayHome, (p) => readFileSync(p, "utf-8")) ?? "";
    const vars: Record<string, string> = {};
    const domainMatch = text.match(/^domain:\s*(.+)$/m);
    if (domainMatch?.[1]?.trim()) {
      vars.DOMAIN = domainMatch[1].trim();
    }
    return vars;
  } catch {
    return {};
  }
}

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

function runCaddyCommand(
  appbayHome: string,
  args: string[],
): { status: CaddyCommandStatus; detail: string } {
  const runtime = containerBin(appbayHome);
  let missing = "the Caddy edge container does not exist";
  for (const container of ["appbay.caddy.caddy", "appbay.caddy"]) {
    // ⚠️ ASK WHETHER IT IS RUNNING, NOT MERELY WHETHER IT EXISTS. A STOPPED container
    // passes a bare `inspect`, so the old check went on to `exec` — which fails with
    // "container state improper" — and that was classified as the CONFIGURATION being
    // rejected. Same lie as the missing-container case (appbay-cli#5), one state along.
    const inspect = spawnSync(runtime, ["inspect", "--format", "{{.State.Running}}", container], {
      stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8",
    });
    if (inspect.status !== 0) {
      missing = `the Caddy edge container does not exist (${String(inspect.stderr || "").trim()})`;
      continue;
    }
    if (String(inspect.stdout ?? "").trim() !== "true") {
      return {
        status: "unavailable",
        detail: `the Caddy edge container "${container}" exists but is not running`,
      };
    }
    const result = spawnSync(runtime, ["exec", container, "caddy", ...args], {
      stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8",
    });
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return { status: result.status === 0 ? "ok" : "rejected", detail };
  }
  // Every candidate container was absent — Caddy was never reached, so there is no verdict
  // about the configuration to report.
  return { status: "unavailable", detail: missing };
}

/**
 * Install manifest-derived Caddy routes/policies, validate the complete imported config,
 * and activate it without restarting Caddy. A failed candidate is rolled back on disk and
 * the last known-good configuration is reloaded.
 */
export async function installCaddyConfig(
  app: Pick<AppCompileResult, "auxiliaryFiles">,
  appbayHome: string,
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

  let activation = runCaddyCommand(appbayHome, [
    "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
  ]);
  if (activation.status === "ok") {
    activation = runCaddyCommand(appbayHome, [
      "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
    ]);
    if (activation.status === "ok") return { ok: true };
  }

  for (const [path, content] of previous) {
    if (content === null) await unlink(path).catch(() => undefined);
    else await writeFile(path, content, "utf-8");
  }
  // Only worth attempting when there is a Caddy to reload; on `unavailable` this is a
  // second no-op against a container that does not exist.
  if (activation.status === "rejected") {
    runCaddyCommand(appbayHome, [
      "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
    ]);
  }
  return {
    ok: false,
    reason: activation.status === "unavailable" ? "unavailable" : "rejected",
    detail: activation.detail || "Caddy rejected the generated configuration.",
  };
}

/**
 * Turn a failed Caddy install into a sentence that names what is actually wrong.
 *
 * ⚠️ ONE HELPER, TWO CALL SITES, ON PURPOSE. `installCaddyConfig` is called from both the
 * new/changed and the unchanged deploy paths, and this repo's dominant defect shape is a
 * fix applied to one of two identical-looking paths (CLAUDE.md records three in one day).
 */
function describeCaddyFailure(
  appName: string,
  install: { reason?: "rejected" | "unavailable"; detail?: string },
): string {
  if (install.reason === "unavailable") {
    return (
      `edge routes NOT installed — the Caddy edge container is not running, so its ` +
      `configuration was never checked (${install.detail}). ${appName}'s own container is ` +
      `up, but it is not reachable through the edge. Deploy the edge first: \`appbay up caddy\`.`
    );
  }
  return `Caddy rejected the generated configuration; generated files rolled back: ${install.detail}`;
}

// ---------------------------------------------------------------------------
// Generic shepherd action runner
// ---------------------------------------------------------------------------

import type { ShepherdAction, ShepherdPhase } from "../traits/types.js";
import { readInstanceConfigText } from "../schemas/instance.js";

interface ShepherdRunResult {
  ran: number;
  errors: string[];
}

async function runShepherdActions(
  actions: ShepherdAction[],
  phase: ShepherdPhase,
  ctx: { appName: string; appbayHome: string; secretEnv?: Record<string, string> },
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
        const result = await runShepherd({
          target: `appbay.${ctx.appName}`,
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
export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const { appbayHome, dockerCompose: runDockerCompose } = options;
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
    compileResult = await compile({
      appsDir,
      rendersDir,
      stateDir,
      apps: targetApps,
      projectVars,
      // 🚨 WITHOUT THIS THE COMPILER SEES A HOST WITH NO GPU. `compile()` falls back to
      // DEFAULT_RUNTIME_FACTS (`gpu.available: false`) when facts are absent, and NO caller
      // passed them — so the gpu trait threw "no GPU detected on the host" on every host,
      // including one with a working GPU. Measured on an RTX 5070 Ti, driver 580.82.09.
      runtimeFacts: detectRuntimeFacts({ stateDir }),
    });
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

  // Phase 2-5: Deploy each app (system apps first, in boot order)
  const orderedApps = sortByDeployOrder(compileResult.apps);

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

      // Resolve secrets
      const secretRefs = extractSecretRefs(app.traitMetadata);
      let secretEnv: Record<string, string> = {};

      if (secretRefs.length > 0) {
        const resolveResult = await resolveSecretsForDeploy(secretRefs);
        if (resolveResult.errors.length > 0) {
          appResult.status = "failed";
          appResult.error = resolveResult.errors
            .map((e) => {
              const hint = e.error.includes("password")
                ? " Run 'appbay secrets init' to create the vault."
                : e.error.includes("not found") || e.error.includes("No provider")
                  ? ` Run 'appbay secrets set ${app.appName}/${e.ref.key} <value>' or 'appbay secrets import ${app.appName}'.`
                  : "";
              return `${e.ref.key} (${e.ref.uri}): ${e.error}${hint}`;
            })
            .join("; ");
          result.apps.push(appResult);
          result.failed++;
          continue;
        }
        secretEnv = resolveResult.env;
      }

      // Load .env.local config overrides into process env (so they participate
      // in compose-level ${VAR} substitution and override compose defaults)
      const envLocalPath = join(appsDir, app.appName, ".env.local");
      try {
        const envLocalContent = await readFile(envLocalPath, "utf-8");
        const configEnv: Record<string, string> = {};
        for (const line of envLocalContent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eq = trimmed.indexOf("=");
          if (eq > 0) configEnv[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
        }
        // Config overrides go first, vault secrets override them
        secretEnv = { ...configEnv, ...secretEnv };
      } catch {
        // No .env.local — fine
      }

      // Resolve wrapper-file secrets (write to shared volume pre-deploy)
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
          continue;
        }
      }

      // Pre-deploy shepherd actions (trait-emitted)
      const shepherdCtx = { appName: app.appName, appbayHome, secretEnv };
      if (app.shepherdActions?.length) {
        const preResult = await runShepherdActions(app.shepherdActions, "pre-deploy", shepherdCtx);
        if (preResult.errors.length > 0) {
          appResult.status = "failed";
          appResult.error = `Pre-deploy shepherd failed: ${preResult.errors.join("; ")}`;
          result.apps.push(appResult);
          result.failed++;
          continue;
        }
      }

      // Docker compose up
      const dcResult = runDockerCompose(["up", "-d"], composePath, secretEnv);
      // `up -d` succeeding means "started", not "still running" — see findCrashedServices.
      const crashed = dcResult.exitCode === 0
        ? findCrashedServices(runDockerCompose, composePath, secretEnv)
        : null;
      if (crashed) {
        appResult.status = "failed";
        appResult.error = `container(s) exited immediately after start: ${crashed}`;
        result.apps.push(appResult);
        result.failed++;
        continue;
      }
      if (dcResult.exitCode !== 0) {
        appResult.status = "failed";
        appResult.error = dcResult.output;
        result.apps.push(appResult);
        result.failed++;
        continue;
      }

      const caddyInstall = await installCaddyConfig(app, appbayHome);
      if (!caddyInstall.ok) {
        appResult.status = "failed";
        appResult.error = describeCaddyFailure(app.appName, caddyInstall);
        // The compose converge already succeeded to reach this line, so the app's own
        // container is running while its routes are not installed. Recording it as a plain
        // failure reported a PARTIAL converge as a total one (appbay-cli#5).
        appResult.containerStartedWithoutRoutes = true;
        result.startedButUnrouted++;
        result.apps.push(appResult);
        result.failed++;
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

      const unchangedSecretRefs = extractSecretRefs(app.traitMetadata);
      let unchangedSecretEnv: Record<string, string> = {};

      if (unchangedSecretRefs.length > 0) {
        const resolveResult = await resolveSecretsForDeploy(unchangedSecretRefs);
        if (resolveResult.errors.length > 0) {
          appResult.status = "failed";
          appResult.error = resolveResult.errors
            .map((e) => {
              const hint = e.error.includes("password")
                ? " Run 'appbay secrets init' to create the vault."
                : e.error.includes("not found") || e.error.includes("No provider")
                  ? ` Run 'appbay secrets set ${app.appName}/${e.ref.key} <value>' or 'appbay secrets import ${app.appName}'.`
                  : "";
              return `${e.ref.key} (${e.ref.uri}): ${e.error}${hint}`;
            })
            .join("; ");
          result.apps.push(appResult);
          result.failed++;
          continue;
        }
        unchangedSecretEnv = resolveResult.env;
      }

      // Load .env.local config overrides (same as changed path)
      const unchangedEnvLocalPath = join(appsDir, app.appName, ".env.local");
      try {
        const envLocalContent = await readFile(unchangedEnvLocalPath, "utf-8");
        const configEnv: Record<string, string> = {};
        for (const line of envLocalContent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eq = trimmed.indexOf("=");
          if (eq > 0) configEnv[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
        }
        unchangedSecretEnv = { ...configEnv, ...unchangedSecretEnv };
      } catch {
        // No .env.local
      }

      // Pre-deploy shepherd actions (ensure secrets volumes exist even for unchanged apps)
      const unchangedShepherdCtx = { appName: app.appName, appbayHome, secretEnv: unchangedSecretEnv };
      if (app.shepherdActions?.length) {
        const preResult = await runShepherdActions(app.shepherdActions, "pre-deploy", unchangedShepherdCtx);
        if (preResult.errors.length > 0) {
          appResult.status = "failed";
          appResult.error = `Pre-deploy shepherd failed: ${preResult.errors.join("; ")}`;
          result.apps.push(appResult);
          result.failed++;
          continue;
        }
      }

      // Ensure container is running
      const existingComposePath = join(rendersDir, app.appName, "docker-compose.rendered.yml");
      if (existsSync(existingComposePath)) {
        // Snapshot BEFORE the converge. An unchanged artifact says nothing about whether
        // the container it describes still exists (appbay-cli#4).
        const before = snapshotContainers(runDockerCompose, existingComposePath, unchangedSecretEnv);
        const dcResult = runDockerCompose(["up", "-d"], existingComposePath, unchangedSecretEnv);
        const after = dcResult.exitCode === 0
          ? snapshotContainers(runDockerCompose, existingComposePath, unchangedSecretEnv)
          : null;
        const converged = didConverge(before, after);
        appResult.convergeAction =
          converged === null ? "unknown" : converged ? "started" : "already-running";
        const crashedUnchanged = dcResult.exitCode === 0
          ? findCrashedServices(runDockerCompose, existingComposePath, unchangedSecretEnv)
          : null;
        if (crashedUnchanged) {
          appResult.status = "failed";
          appResult.error = `container(s) exited immediately after start: ${crashedUnchanged}`;
          result.apps.push(appResult);
          result.failed++;
          continue;
        }
        if (dcResult.exitCode !== 0) {
          appResult.status = "failed";
          appResult.error = dcResult.output;
          result.apps.push(appResult);
          result.failed++;
          continue;
        }
      }

      const caddyInstall = await installCaddyConfig(app, appbayHome);
      if (!caddyInstall.ok) {
        appResult.status = "failed";
        appResult.error = describeCaddyFailure(app.appName, caddyInstall);
        // The compose converge already succeeded to reach this line, so the app's own
        // container is running while its routes are not installed. Recording it as a plain
        // failure reported a PARTIAL converge as a total one (appbay-cli#5).
        appResult.containerStartedWithoutRoutes = true;
        result.startedButUnrouted++;
        result.apps.push(appResult);
        result.failed++;
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

    result.apps.push(appResult);
  }

  return result;
}
