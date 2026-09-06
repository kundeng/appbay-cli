/**
 * The unit of a deploy. A converge is one thing about one app that is made true and then
 * observed: its render on disk, its secrets resolved, its compose project up, its edge
 * route installed. Each answers one of three ways, and the third is `Inspection`'s unknown
 * lifted one level: a converge that could not look does not get to say ok or failed.
 *
 * The executor holds the one rule that used to be fifteen `notReady.add` calls: a converge
 * whose dependency is not `converged` is skipped, with the dependency named. Across apps the
 * dependencies are the other app's project and route; within an app it is the previous link.
 */
import type { DockerComposeRunner, Observer } from "../../runtime/observe.js";

/** What `up -d` did to the containers; the vocabulary the deploy report already prints. */
export type ConvergeAction = "started" | "already-running" | "unknown";

/**
 * Why a converge diverged, where the fold needs to tell cases apart: `not-ready` is a
 * project whose container is up but never became ready (a partial converge, like a missing
 * route); `skipped` is the executor's verdict, not the link's own.
 */
export type DivergedReason = "rejected" | "unavailable" | "timeout" | "write-failed" | "not-ready" | "skipped";

export type Verdict =
  | { kind: "converged"; action?: ConvergeAction; unknownReason?: string }
  | { kind: "diverged"; detail: string; reason?: DivergedReason; errors?: string[] }
  | { kind: "unobservable"; reason: string };

/** The links of one app's chain, in the order they run and the order the fold reads them. */
export const CHAIN = ["compile", "render", "secrets", "shepherd:pre", "project", "route", "shepherd:post"] as const;
export type ConvergeKind = (typeof CHAIN)[number];

export interface DeployContext {
  appbayHome: string;
  appsDir: string;
  rendersDir: string;
  observer: Observer;
  dockerCompose: DockerComposeRunner;
  sleep: (ms: number) => Promise<void>;
  crashGraceMs: number;
  readinessTimeoutMs: number;
}

export interface Converge {
  /** `<app>/<kind>`; what `dependsOn` names. */
  readonly id: string;
  readonly app: string;
  readonly kind: ConvergeKind;
  readonly dependsOn: readonly string[];
  run(ctx: DeployContext): Promise<Verdict>;
}

export const convergeId = (app: string, kind: ConvergeKind): string => `${app}/${kind}`;

export const converged = (action?: ConvergeAction, unknownReason?: string): Verdict =>
  action === undefined ? { kind: "converged" } : { kind: "converged", action, ...(unknownReason === undefined ? {} : { unknownReason }) };
export const diverged = (detail: string, reason?: DivergedReason, errors?: string[]): Verdict =>
  ({ kind: "diverged", detail, ...(reason === undefined ? {} : { reason }), ...(errors === undefined ? {} : { errors }) });
export const unobservable = (reason: string): Verdict => ({ kind: "unobservable", reason });

/**
 * Walk the converges in the order the planner emitted them, which is execution order:
 * apps in `deployOrder`, each app's chain in `CHAIN` order. A dependency that is absent
 * from the map (the app had a compile error and emitted no project) or unobservable is
 * unmet: nothing starts over a dependency nobody saw ready. A link that throws diverged;
 * the apps already converged keep their verdicts and the report still comes out.
 */
export async function runConverges(converges: readonly Converge[], ctx: DeployContext): Promise<Map<string, Verdict>> {
  const verdicts = new Map<string, Verdict>();
  for (const c of converges) {
    const unmet = c.dependsOn.filter((d) => verdicts.get(d)?.kind !== "converged");
    if (unmet.length === 0) {
      try {
        verdicts.set(c.id, await c.run(ctx));
      } catch (err) {
        verdicts.set(c.id, diverged(err instanceof Error ? err.message : String(err)));
      }
      continue;
    }
    const apps = [...new Set(unmet.map((d) => d.slice(0, d.indexOf("/"))))].filter((a) => a !== c.app);
    verdicts.set(c.id, diverged(
      apps.length > 0
        ? `skipped: depends on ${apps.join(", ")}, which did not become ready`
        : `skipped: ${unmet[0]} did not converge`,
      "skipped",
    ));
  }
  return verdicts;
}
