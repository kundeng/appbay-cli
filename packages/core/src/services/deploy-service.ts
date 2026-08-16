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
import { runPostDeployHook } from "../post-deploy.js";

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
function findCrashedServices(
  runDockerCompose: DockerComposeRunner,
  composePath: string,
  env: Record<string, string>,
): string | null {
  // `--format json` is supported by compose v2 and by podman's provider alike; `-a` is
  // required or exited containers are simply not listed, which would make this check
  // silently vacuous — the exact failure mode it exists to prevent.
  const ps = runDockerCompose(["ps", "-a", "--format", "json"], composePath, env);
  if (ps.exitCode !== 0) return null; // Cannot inspect — do not invent a failure.

  const dead: string[] = [];
  for (const line of ps.output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rows: unknown;
    try {
      rows = JSON.parse(trimmed);
    } catch {
      continue; // Some providers emit one object per line, others a single array.
    }
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      const r = row as { Service?: string; Name?: string; State?: string; ExitCode?: number };
      const exit = typeof r.ExitCode === "number" ? r.ExitCode : 0;
      const state = (r.State ?? "").toLowerCase();
      if (state === "exited" && exit !== 0) {
        dead.push(`${r.Service ?? r.Name ?? "?"} exited ${String(exit)}`);
      }
    }
  }
  return dead.length > 0 ? dead.join(", ") : null;
}

/** Callback for discovering currently running apps. */
export type RunningAppsDiscoverer = () => Set<string>;

/** Per-app deploy result in the shepherd pipeline. */
export interface AppDeployResult {
  appName: string;
  status: "deployed" | "unchanged" | "failed";
  isSystem: boolean;
  planStatus: "new" | "changed" | "unchanged";
  error?: string;
  shepherdErrors?: string[];
  hookResult?: { ran: boolean; error?: string };
}

/** Full deploy pipeline result. */
export interface DeployResult {
  apps: AppDeployResult[];
  deployed: number;
  unchanged: number;
  failed: number;
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
  discoverRunning: RunningAppsDiscoverer;
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
  const configPath = join(appbayHome, "project.yaml");
  try {
    const text = await readFile(configPath, "utf-8");
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

function runCaddyCommand(appbayHome: string, args: string[]): { ok: boolean; detail: string } {
  const runtime = containerBin(appbayHome);
  let missing = "Caddy container is not running.";
  for (const container of ["appbay.caddy.caddy", "appbay.caddy"]) {
    const inspect = spawnSync(runtime, ["inspect", container], {
      stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8",
    });
    if (inspect.status !== 0) {
      missing = String(inspect.stderr || missing).trim();
      continue;
    }
    const result = spawnSync(runtime, ["exec", container, "caddy", ...args], {
      stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8",
    });
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return { ok: result.status === 0, detail };
  }
  return { ok: false, detail: missing };
}

/**
 * Install manifest-derived Caddy routes/policies, validate the complete imported config,
 * and activate it without restarting Caddy. A failed candidate is rolled back on disk and
 * the last known-good configuration is reloaded.
 */
export async function installCaddyConfig(
  app: Pick<AppCompileResult, "auxiliaryFiles">,
  appbayHome: string,
): Promise<{ ok: boolean; detail?: string }> {
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
  if (activation.ok) {
    activation = runCaddyCommand(appbayHome, [
      "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
    ]);
    if (activation.ok) return { ok: true };
  }

  for (const [path, content] of previous) {
    if (content === null) await unlink(path).catch(() => undefined);
    else await writeFile(path, content, "utf-8");
  }
  runCaddyCommand(appbayHome, [
    "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
  ]);
  return { ok: false, detail: activation.detail || "Caddy rejected the generated configuration." };
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
  const { appbayHome, dockerCompose: runDockerCompose, discoverRunning } = options;
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
  const activeApps = discoverRunning();
  const projectVars = options.projectVars ?? await loadProjectVars(appbayHome);

  let compileResult: CompileResult;
  try {
    compileResult = await compile({
      appsDir,
      rendersDir,
      stateDir,
      apps: targetApps,
      activeApps,
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
      failed: 0,
      compileErrors: [{ stage: "compile", message: err instanceof Error ? err.message : String(err) }],
    };
  }

  const result: DeployResult = {
    apps: [],
    deployed: 0,
    unchanged: 0,
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
        appResult.error = `Caddy configuration rejected; generated files rolled back: ${caddyInstall.detail}`;
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

      // Legacy post-deploy hook (will migrate to trait-emitted shepherd actions)
      appResult.hookResult = await runPostDeployHook({
        appName: app.appName,
        appbayHome,
        secretEnv,
      });

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
        const dcResult = runDockerCompose(["up", "-d"], existingComposePath, unchangedSecretEnv);
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
        appResult.error = `Caddy configuration rejected; generated files rolled back: ${caddyInstall.detail}`;
        result.apps.push(appResult);
        result.failed++;
        continue;
      }

      result.unchanged++;
    }

    result.apps.push(appResult);
  }

  return result;
}
