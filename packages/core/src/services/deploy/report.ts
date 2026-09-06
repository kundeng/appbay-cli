/**
 * The deploy report is a fold over verdicts, computed once after every converge ran. No
 * counter moves while the deploy is in progress, so no step grants a `deployed` that a later
 * step has to take back; the readiness wait used to decrement one.
 */
import { isSystemApp } from "../../boot-order.js";
import { CHAIN, convergeId, type ConvergeAction, type Verdict } from "./converge.js";

export type PlanStatus = "new" | "changed" | "unchanged";

/** Per-app deploy result. */
export interface AppDeployResult {
  appName: string;
  /**
   * What happened to the DEPLOYMENT. Distinct from `planStatus`, which is what happened to
   * the compiled artifact — see didConverge() and appbay-cli#4.
   */
  status: "deployed" | "unchanged" | "failed";
  isSystem: boolean;
  /** What happened to the COMPILED ARTIFACT. Never a statement about containers. */
  planStatus: PlanStatus;
  /**
   * What `up -d` did to the running containers, on every path. `unknown` when compose could
   * not be asked, in which case the honest answer is that we do not know. Absent when the
   * project converge never ran.
   */
  convergeAction?: ConvergeAction;
  /** Why the runtime could not be read, when `convergeAction` is "unknown". */
  unknownReason?: string;
  /**
   * The app's container is up and it is not reachable: its edge route did not land, or it
   * never became ready. A partial converge, not a total failure (appbay-cli#5).
   */
  containerStartedWithoutRoutes?: boolean;
  error?: string;
  /** Post-deploy shepherd actions that failed, one entry per action; the app still deployed. */
  shepherdErrors?: string[];
}

/** Full deploy pipeline result. */
export interface DeployResult {
  apps: AppDeployResult[];
  deployed: number;
  unchanged: number;
  failed: number;
  /**
   * Apps whose own container is running but which are NOT reachable — a PARTIAL converge.
   * Counted separately because neither `deployed` nor `failed` is honest on its own: the
   * app is up, and it is unreachable (appbay-cli#5).
   */
  startedButUnrouted: number;
  compileErrors: Array<{ appName?: string; stage: string; message: string }>;
  warnings?: string[];
}

export function emptyDeployResult(compileErrors: DeployResult["compileErrors"] = [], warnings?: string[]): DeployResult {
  return {
    apps: [], deployed: 0, unchanged: 0, failed: 0, startedButUnrouted: 0, compileErrors,
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * One app's row. The verdicts are read in chain order and the first that is not
 * `converged` decides:
 *
 * | first non-converged                                       | status    | carries                                   |
 * |-----------------------------------------------------------|-----------|-------------------------------------------|
 * | none                                                      | see below | convergeAction, unknownReason              |
 * | compile, render, secrets, shepherd:pre: diverged          | failed    | error = detail                             |
 * | project: diverged, reason not-ready                       | failed    | error, containerStartedWithoutRoutes       |
 * | project: diverged, any other reason                       | failed    | error = detail                             |
 * | project: unobservable                                     | unchanged | convergeAction unknown, unknownReason      |
 * | route: diverged                                           | failed    | error, containerStartedWithoutRoutes       |
 * | shepherd:post: diverged                                   | as "none" | shepherdErrors                             |
 *
 * With nothing diverged, a new or changed plan is `deployed`: the converge was the point.
 * An unchanged plan is `deployed` only when compose started something (appbay-cli#4), and
 * `unchanged` when it was already running or could not say.
 */
export function foldApp(appName: string, planStatus: PlanStatus, verdicts: Map<string, Verdict>): AppDeployResult {
  const row: AppDeployResult = { appName, status: "unchanged", isSystem: isSystemApp(appName), planStatus };
  const project = verdicts.get(convergeId(appName, "project"));
  if (project?.kind === "converged" && project.action !== undefined) {
    row.convergeAction = project.action;
    if (project.unknownReason !== undefined) row.unknownReason = project.unknownReason;
  }
  for (const kind of CHAIN) {
    const v = verdicts.get(convergeId(appName, kind));
    if (v === undefined || v.kind === "converged") continue;
    if (kind === "shepherd:post" && v.kind === "diverged") {
      row.shepherdErrors = v.errors ?? [v.detail];
      continue;
    }
    if (kind === "project" && v.kind === "unobservable") {
      row.convergeAction = "unknown";
      row.unknownReason = v.reason;
      return row;
    }
    row.status = "failed";
    row.error = v.kind === "diverged" ? v.detail : v.reason;
    if (kind === "route" || (kind === "project" && v.kind === "diverged" && v.reason === "not-ready")) {
      row.containerStartedWithoutRoutes = true;
    }
    return row;
  }
  const started = project?.kind === "converged" && project.action === "started";
  row.status = planStatus !== "unchanged" || started ? "deployed" : "unchanged";
  return row;
}

export function foldDeployResult(
  apps: ReadonlyArray<{ appName: string; planStatus: PlanStatus }>,
  verdicts: Map<string, Verdict>,
  base: Pick<DeployResult, "compileErrors" | "warnings">,
): DeployResult {
  const rows = apps.map((a) => foldApp(a.appName, a.planStatus, verdicts));
  const count = (status: AppDeployResult["status"]) => rows.filter((r) => r.status === status).length;
  return {
    ...emptyDeployResult(base.compileErrors, base.warnings),
    apps: rows,
    deployed: count("deployed"),
    unchanged: count("unchanged"),
    failed: count("failed"),
    startedButUnrouted: rows.filter((r) => r.containerStartedWithoutRoutes).length,
  };
}
