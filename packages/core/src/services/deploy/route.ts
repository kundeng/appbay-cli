/**
 * The edge route: the one converge that talks to a process other than compose. Caddy
 * validates and reloads; traefik watches a directory, so the file on disk is the install and
 * the observation is that a running traefik exists to read it. On both providers the route
 * files are written here, after the upstream is up and the edge is seen running: a fragment
 * written at render time pointed traefik at a container that had not started, and writing
 * the file with no edge is not a route (review 2026-09-05, F1).
 *
 * The edge is found by its label, never by a literal name: the namespace enters every
 * generated name (identity.ts), and a literal went stale the day the system apps were
 * namespaced.
 */
import { join, dirname } from "node:path";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import type { AppCompileResult } from "../../compiler/index.js";
import { containerExec, resolveIngressProvider } from "../../runtime/container-runtime.js";
import { findContainerByLabel, engineObserver, type Observer } from "../../runtime/observe.js";
import { APP_LABEL } from "../../compiler/identity.js";

type RouteFile = { path: string; content: string };

export function isCaddyConfigPath(path: string): boolean {
  return path.startsWith("etc/apps/caddy/config/dynamic/") ||
    path.startsWith("etc/apps/caddy/config/security/policies/");
}

/** An auxiliary file that is an edge route or policy, on either provider: installed by this module, not by the render. */
export function isRouteFilePath(path: string): boolean {
  return isCaddyConfigPath(path) || path.startsWith("etc/apps/traefik/config/dynamic/");
}

/** Write the route files under APPBAY_HOME; the caller decides when. Throws on a failed write. */
async function writeRouteFiles(files: RouteFile[], appbayHome: string): Promise<void> {
  for (const aux of files) {
    const path = join(appbayHome, aux.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, aux.content, "utf-8");
  }
}

/** What the route files held before a candidate is written, and the function that puts it back. */
async function snapshotRouteFiles(files: RouteFile[], appbayHome: string): Promise<() => Promise<void>> {
  const previous = new Map<string, string | null>();
  for (const aux of files) {
    const path = join(appbayHome, aux.path);
    previous.set(path, await readFile(path, "utf-8").catch(() => null));
  }
  return async () => {
    for (const [path, content] of previous) {
      if (content === null) await unlink(path).catch(() => undefined);
      else await writeFile(path, content, "utf-8");
    }
  };
}

/**
 * The answers a validator can give. `unavailable` is NOT a kind of `rejected`, and neither is
 * `timeout`: Caddy was asked and did not answer.
 *
 * 🚨 THESE WERE ONE BOOLEAN AND IT MISDIAGNOSED THE OPERATOR (appbay-cli#5). With the edge
 * not deployed, `no such object: appbay.caddy` — the ENGINE saying the container to exec
 * into does not exist — was returned as `ok: false` and rendered as "Caddy configuration
 * rejected". Caddy was never asked. A check that could not run must not return a verdict.
 */
type CaddyCommandStatus = "ok" | "rejected" | "unavailable" | "timeout";

const CADDY_EXEC_TIMEOUT_MS = 60_000;

async function runCaddyCommand(
  appbayHome: string,
  args: string[],
  observer?: Observer,
): Promise<{ status: CaddyCommandStatus; detail: string }> {
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
  const result = containerExec(["exec", edge.value.name, "caddy", ...args], {
    appbayHome, stdio: ["pipe", "pipe", "pipe"], timeout: CADDY_EXEC_TIMEOUT_MS, label: "caddy exec",
  });
  if (result.failedToStart) return { status: "unavailable", detail: `could not exec into the edge: ${result.output}` };
  if (result.timedOut) return { status: "timeout", detail: `caddy ${args[0] ?? ""} did not answer within ${String(CADDY_EXEC_TIMEOUT_MS / 1000)} s` };
  return { status: result.exitCode === 0 ? "ok" : "rejected", detail: result.output.trim() };
}

/** The shape every route install answers with, on either provider. */
export interface RouteInstallResult { ok: boolean; reason?: "rejected" | "unavailable" | "timeout" | "write-failed"; detail?: string }

/**
 * Install manifest-derived Caddy routes/policies, validate the complete imported config,
 * and activate it without restarting Caddy. A failed candidate is rolled back on disk and
 * the last known-good configuration is reloaded.
 */
export async function installCaddyConfig(
  app: Pick<AppCompileResult, "auxiliaryFiles">,
  appbayHome: string,
  observer?: Observer,
): Promise<RouteInstallResult> {
  const files = app.auxiliaryFiles.filter((aux) => isCaddyConfigPath(aux.path));
  if (files.length === 0) return { ok: true };

  const restore = await snapshotRouteFiles(files, appbayHome);
  try {
    await writeRouteFiles(files, appbayHome);
  } catch (err) {
    await restore();
    return { ok: false, reason: "write-failed", detail: err instanceof Error ? err.message : String(err) };
  }

  const caddyfile = ["--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"];
  let activation = await runCaddyCommand(appbayHome, ["validate", ...caddyfile], observer);
  if (activation.status === "ok") {
    activation = await runCaddyCommand(appbayHome, ["reload", ...caddyfile], observer);
    if (activation.status === "ok") return { ok: true };
  }

  await restore();
  // A reload is only attempted when there is a Caddy to reload; on `unavailable` it would be
  // a second no-op against a container that does not exist. After a timeout Caddy may be
  // serving the candidate while the disk holds the previous files, so the reload is tried,
  // and its answer is part of the report: "rolled back" is a claim about Caddy, not the disk.
  let detail = activation.detail || "Caddy rejected the generated configuration.";
  if (activation.status !== "unavailable") {
    const reload = await runCaddyCommand(appbayHome, ["reload", ...caddyfile], observer);
    detail += reload.status === "ok"
      ? "; the previous configuration was reloaded"
      : `; the previous configuration could NOT be reloaded (${reload.detail})`;
  }
  return { ok: false, reason: activation.status, detail };
}

/** Install the app's edge route on whichever provider fronts this install, and observe the edge before saying so. */
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
  const restore = await snapshotRouteFiles(files, appbayHome);
  try {
    await writeRouteFiles(files, appbayHome);
  } catch (err) {
    await restore();
    return { ok: false, reason: "write-failed", detail: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}

/** Turn a failed route install into a sentence that names what is actually wrong. */
export function describeRouteFailure(
  appName: string,
  install: RouteInstallResult,
  provider: string,
): string {
  if (install.reason === "unavailable" && /running containers carry/.test(install.detail ?? "")) {
    return `edge routes NOT installed — more than one ${provider} edge is running (${install.detail}); the route was not installed because it cannot be told which edge to ask. Remove the extra container, then \`appbay up ${appName}\`.`;
  }
  if (install.reason === "unavailable") {
    return (
      `edge routes NOT installed — the ${provider} edge is not running, so ${appName}'s route ` +
      `was never installed (${install.detail}). ${appName}'s own container is up, but it is ` +
      `not reachable through the edge. Deploy the edge first: \`appbay up ${provider}\`.`
    );
  }
  if (install.reason === "timeout") {
    return `edge routes NOT installed — ${install.detail}; the generated files were rolled back. ${appName}'s own container is up, but it is not reachable through the edge until the edge answers.`;
  }
  if (install.reason === "write-failed") {
    return `edge routes NOT installed — the route files could not be written: ${install.detail}. ${appName}'s own container is up, but it is not reachable through the edge.`;
  }
  return `${provider} rejected the generated configuration; generated files rolled back: ${install.detail}`;
}
