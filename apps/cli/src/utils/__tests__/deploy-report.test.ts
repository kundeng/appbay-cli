/**
 * The one deploy printer: compile errors are printed by it (not by each caller), and the
 * deployed row says what the observer saw, not "Started" for every plan (S48 rounds 4–5).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { DeployResult } from "@appbay/core";
import { printDeployReport } from "../deploy-report.js";

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = []; const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.join(" ")); });
  return { out, err, restore: () => { log.mockRestore(); error.mockRestore(); } };
}
const base = (over: Partial<DeployResult>): DeployResult =>
  ({ apps: [], deployed: 0, unchanged: 0, failed: 0, startedButUnrouted: 0, compileErrors: [], ...over });
afterEach(() => vi.restoreAllMocks());

describe("printDeployReport", () => {
  it("prints compile errors once, and counts them without doubling an app that also failed", () => {
    const c = capture();
    const r = printDeployReport(base({
      compileErrors: [{ appName: "db", stage: "ingress", message: "no host" }, { stage: "projects", message: "cycle" }],
      apps: [{ appName: "db", status: "failed", isSystem: false, planStatus: "new", error: "not deployed: its configuration did not compile" }],
      failed: 1,
    }));
    c.restore();
    expect(c.err.filter((l) => l === "Compile errors:")).toHaveLength(1);
    expect(c.err.join("\n")).toContain("[db] ingress: no host");
    expect(c.err.join("\n")).toContain("[global] projects: cycle");
    expect(c.out.join("\n")).toContain("0 deployed, 0 unchanged, 2 error(s)");
    expect(r.hasFailures).toBe(true);
  });

  it("words a deployed row by what compose did", () => {
    const c = capture();
    printDeployReport(base({
      apps: [
        { appName: "a", status: "deployed", isSystem: false, planStatus: "new", convergeAction: "started" },
        { appName: "b", status: "deployed", isSystem: false, planStatus: "unchanged", convergeAction: "started" },
        { appName: "c", status: "deployed", isSystem: false, planStatus: "changed", convergeAction: "already-running" },
        { appName: "d", status: "deployed", isSystem: false, planStatus: "new", convergeAction: "unknown", unknownReason: "socket flaked" },
      ],
      deployed: 4,
    }));
    c.restore();
    const text = c.out.join("\n");
    expect(text).toContain("Started a");
    expect(text).toContain("Started b — the plan was unchanged, the container was not");
    expect(text).toContain("Converged c; compose changed nothing");
    expect(text).toContain("Converged d; could not read whether it started (socket flaked)");
    expect(text).not.toMatch(/Started [cd]\b/);
  });

  it("a partial converge is counted apart and named", () => {
    const c = capture();
    printDeployReport(base({
      apps: [{ appName: "web", status: "failed", isSystem: false, planStatus: "new", error: "edge routes NOT installed", containerStartedWithoutRoutes: true }],
      failed: 1, startedButUnrouted: 1,
    }));
    c.restore();
    expect(c.out.join("\n")).toContain("1 app(s) STARTED but are NOT reachable");
  });
});
