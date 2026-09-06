/**
 * One app's chain of converges, and the planner that strings the chains together in the
 * order `deployOrder` gave. Each link returns a Verdict and touches no counter; the report
 * is folded from the verdicts afterwards (report.ts).
 *
 * Compose is the differ for containers: `up -d` runs on every deploy, whatever the plan
 * said about the rendered file, and the snapshot pair around it says what compose did. An
 * unchanged artifact says nothing about whether the container it describes still exists
 * (appbay-cli#4).
 */
import { join } from "node:path";
import { readFile, writeFile, mkdir, copyFile, chmod } from "node:fs/promises";
import type { AppCompileResult } from "../../compiler/index.js";
import { resolveSecretsForDeploy, extractSecretRefs } from "../../secrets/resolve-for-deploy.js";
import { resolveIngressProvider } from "../../runtime/container-runtime.js";
import { findCrashedServices, snapshotContainers, didConverge, isReady, type Observer } from "../../runtime/observe.js";
import { APP_LABEL, shepherdTarget } from "../../compiler/identity.js";
import type { ShepherdAction, ShepherdPhase } from "../../traits/types.js";
import { parseEnvFile } from "../config-service.js";
import { isCaddyConfigPath, installRoute, describeRouteFailure } from "./route.js";
import { convergeId, converged, diverged, unobservable, type Converge, type ConvergeAction, type ConvergeKind, type DeployContext } from "./converge.js";

// ---------------------------------------------------------------------------
// The bodies: also called on their own by the edge migration (apps/cli edge.ts)
// ---------------------------------------------------------------------------

/**
 * Write rendered compile output to the renders directory. Auxiliary file paths are
 * resolved relative to APPBAY_HOME; edge route and policy files are not written here but
 * installed transactionally once the upstream is running (route.ts).
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

  for (const aux of app.auxiliaryFiles) {
    if (isCaddyConfigPath(aux.path)) continue;
    const auxPath = join(appbayHome, aux.path);
    const auxDir = auxPath.substring(0, auxPath.lastIndexOf("/"));
    if (auxDir) {
      await mkdir(auxDir, { recursive: true });
    }
    await writeFile(auxPath, aux.content, "utf-8");
    if (auxPath.endsWith(".sh")) await chmod(auxPath, 0o755);
  }

  return composePath;
}

/**
 * The environment a compose child gets for one app: `.env.local` overrides first, resolved
 * secret references over them. One resolver for the deploy and for the edge migration's
 * validate step, which must see the same values the deploy will.
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

async function runShepherdActions(
  actions: ShepherdAction[],
  phase: ShepherdPhase,
  ctx: { appName: string; appbayHome: string; secretEnv?: Record<string, string>; observer: Observer },
): Promise<string[]> {
  const errors: string[] = [];
  for (const action of actions.filter((a) => a.phase === phase)) {
    try {
      if (action.run) {
        await action.run(ctx);
      } else if (action.image) {
        const { runShepherd } = await import("../../shepherd/run-shepherd.js");
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
        if (result.exitCode !== 0) errors.push(`${action.label}: exit ${result.exitCode} — ${result.stderr}`);
      }
    } catch (err) {
      errors.push(`${action.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/** What the planner knows about one app beyond its compile output. */
interface PlannedApp {
  app: AppCompileResult;
  /** The compiler reported an error for this app: it is refused, not deployed half-configured. */
  compileFailed: boolean;
  /** Apps that must be ready before this one starts (`deployOrder`). */
  dependsOn: ReadonlySet<string>;
  /** Something starts after this app: its project waits, bounded, until it is ready. */
  waitReady: boolean;
}

/** The converges of every app, in execution order. */
export function planConverges(apps: readonly PlannedApp[]): Converge[] {
  return apps.flatMap(appChain);
}

function appChain({ app, compileFailed, dependsOn, waitReady }: PlannedApp): Converge[] {
  const name = app.appName;
  const upstream = [...dependsOn].map((d) => convergeId(d, "project"));
  const link = (kind: ConvergeKind, after: ConvergeKind | null, run: Converge["run"]): Converge =>
    ({ id: convergeId(name, kind), app: name, kind, dependsOn: after === null ? upstream : [convergeId(name, after)], run });

  // 🚨 AN APP WHOSE CONFIGURATION DID NOT COMPILE IS NOT DEPLOYED. It used to be: an ingress
  // trait that failed to resolve produced a running container with no route, healthy in
  // every listing and unreachable (issue #60, journey 7). Scoped to the failing app; its
  // neighbours still deploy.
  if (compileFailed) {
    return [link("compile", null, async () => diverged(
      "not deployed: its configuration did not compile (see the errors above). " +
      "Deploying it would start a container that cannot serve its declared routes.",
    ))];
  }

  // Shared by the links that run after `secrets`: the env the compose child and the
  // shepherd actions see.
  const state = { env: {} as Record<string, string> };

  return [
    link("render", null, async (ctx) => {
      try {
        await writeRenderedOutput(app, ctx.rendersDir, ctx.appbayHome);
      } catch (err) {
        return diverged(`Failed to write rendered output: ${err instanceof Error ? err.message : String(err)}`);
      }
      // compose reads `.env` beside the file it is given; keep it a copy of the app's.
      const envDst = join(ctx.rendersDir, name, ".env");
      await copyFile(join(ctx.appsDir, name, ".env"), envDst)
        .catch(() => writeFile(envDst, "", { flag: "a" }))
        .catch(() => undefined);
      return converged();
    }),

    link("secrets", "render", async (ctx) => {
      const resolved = await resolveDeployEnv(app, ctx.appsDir);
      if (resolved.error) return diverged(resolved.error);
      state.env = resolved.env;
      return converged();
    }),

    link("shepherd:pre", "secrets", async (ctx) => {
      const errors = await runShepherdActions(app.shepherdActions ?? [], "pre-deploy", { appName: name, appbayHome: ctx.appbayHome, secretEnv: state.env, observer: ctx.observer });
      return errors.length > 0 ? diverged(`Pre-deploy shepherd failed: ${errors.join("; ")}`) : converged();
    }),

    link("project", "shepherd:pre", async (ctx) => {
      const composePath = join(ctx.rendersDir, name, "docker-compose.rendered.yml");
      const before = await snapshotContainers(ctx.observer, name);
      const dc = ctx.dockerCompose(["up", "-d"], composePath, state.env);
      if (dc.exitCode !== 0) return diverged(dc.output);
      const after = await snapshotContainers(ctx.observer, name);
      // `up -d` returning means "started", not "still running": read now, and once more after
      // the grace, because a bad config kills the process a moment after start.
      let crashed = await findCrashedServices(ctx.observer, name);
      if (crashed.kind === "ok" && crashed.value.length === 0 && ctx.crashGraceMs > 0) {
        await ctx.sleep(ctx.crashGraceMs);
        crashed = await findCrashedServices(ctx.observer, name);
      }
      if (crashed.kind === "unknown") return unobservable(crashed.reason);
      if (crashed.value.length > 0) return diverged(`container(s) exited immediately after start: ${crashed.value.join(", ")}`);
      const moved = didConverge(before, after);
      const action: ConvergeAction = moved.kind === "unknown" ? "unknown" : moved.value ? "started" : "already-running";
      const verdict = converged(action, moved.kind === "unknown" ? moved.reason : undefined);
      if (!waitReady) return verdict;
      const deadline = Date.now() + ctx.readinessTimeoutMs;
      let last = "";
      for (;;) {
        const probe = await isReady(ctx.observer, name);
        if (probe.kind === "unknown") { last = `could not ask compose (${probe.reason})`; break; }
        if (probe.value.ready) return verdict;
        last = probe.value.detail;
        if (Date.now() >= deadline) break;
        await ctx.sleep(2000);
      }
      return diverged(`not ready within ${String(Math.round(ctx.readinessTimeoutMs / 1000))}s: ${last}`);
    }),

    link("route", "project", async (ctx) => {
      const install = await installRoute(app, ctx.appbayHome, ctx.observer);
      if (install.ok) return converged();
      return diverged(describeRouteFailure(name, install, resolveIngressProvider(ctx.appbayHome)), install.reason);
    }),

    link("shepherd:post", "route", async (ctx) => {
      const errors = await runShepherdActions(app.shepherdActions ?? [], "post-deploy", { appName: name, appbayHome: ctx.appbayHome, secretEnv: state.env, observer: ctx.observer });
      return errors.length > 0 ? diverged(errors.join("; ")) : converged();
    }),
  ];
}
