/**
 * The edge route: the one converge that talks to a process other than compose. Caddy
 * validates and reloads; traefik watches a directory, so the file on disk is the install and
 * the observation is that a running traefik exists to read it. Writing the file with no
 * edge is not a route (review 2026-09-05, F1).
 *
 * The edge is found by its label, never by a literal name: the namespace enters every
 * generated name (identity.ts), and a literal went stale the day the system apps were
 * namespaced.
 */
import { join, dirname } from "node:path";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import type { AppCompileResult } from "../../compiler/index.js";
import { containerBin, resolveIngressProvider } from "../../runtime/container-runtime.js";
import { findContainerByLabel, engineObserver, type Observer } from "../../runtime/observe.js";
import { APP_LABEL } from "../../compiler/identity.js";

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
 * rejected". Caddy was never asked. A check that could not run must not return a verdict.
 */
type CaddyCommandStatus = "ok" | "rejected" | "unavailable";

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
  const result = spawnSync(containerBin(appbayHome), ["exec", edge.value.name, "caddy", ...args], {
    stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8",
  });
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { status: result.status === 0 ? "ok" : "rejected", detail };
}

/** The shape every route install answers with, on either provider. */
export interface RouteInstallResult { ok: boolean; reason?: "rejected" | "unavailable"; detail?: string }

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

  const previous = new Map<string, string | null>();
  for (const aux of files) {
    const path = join(appbayHome, aux.path);
    previous.set(path, await readFile(path, "utf-8").catch(() => null));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, aux.content, "utf-8");
  }

  const caddyfile = ["--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"];
  let activation = await runCaddyCommand(appbayHome, ["validate", ...caddyfile], observer);
  if (activation.status === "ok") {
    activation = await runCaddyCommand(appbayHome, ["reload", ...caddyfile], observer);
    if (activation.status === "ok") return { ok: true };
  }

  for (const [path, content] of previous) {
    if (content === null) await unlink(path).catch(() => undefined);
    else await writeFile(path, content, "utf-8");
  }
  // A reload is only attempted when there is a Caddy to reload; on `unavailable` it would be
  // a second no-op against a container that does not exist.
  if (activation.status === "rejected") {
    await runCaddyCommand(appbayHome, ["reload", ...caddyfile], observer);
  }
  return {
    ok: false,
    reason: activation.status === "unavailable" ? "unavailable" : "rejected",
    detail: activation.detail || "Caddy rejected the generated configuration.",
  };
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
  return { ok: true };
}

/** Turn a failed route install into a sentence that names what is actually wrong. */
export function describeRouteFailure(
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
