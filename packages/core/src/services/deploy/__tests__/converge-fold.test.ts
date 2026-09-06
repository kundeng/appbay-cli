/**
 * The fold table in report.ts, row by row, over hand-built verdicts; and the executor's one
 * skip rule, including the case the loop used to get wrong: an unobservable dependency let
 * its dependents start.
 */
import { describe, it, expect } from "vitest";
import { convergeId, converged, diverged, unobservable, runConverges, type Converge, type DeployContext, type Verdict } from "../converge.js";
import { foldApp, foldDeployResult } from "../report.js";

const APP = "whoami";
const verdicts = (entries: Array<[Parameters<typeof convergeId>[1], Verdict]>): Map<string, Verdict> =>
  new Map(entries.map(([kind, v]) => [convergeId(APP, kind), v]));
const allBut = (kind: Parameters<typeof convergeId>[1], v: Verdict, action: Verdict = converged("already-running")): Map<string, Verdict> =>
  verdicts([["render", converged()], ["secrets", converged()], ["shepherd:pre", converged()], ["project", action], ["route", converged()], ["shepherd:post", converged()], [kind, v]]);

describe("foldApp: the first non-converged link decides", () => {
  it("an unchanged plan whose project started is deployed; already-running is unchanged", () => {
    expect(foldApp(APP, "unchanged", allBut("route", converged(), converged("started")))).toMatchObject({ status: "deployed", convergeAction: "started" });
    expect(foldApp(APP, "unchanged", allBut("route", converged()))).toMatchObject({ status: "unchanged", convergeAction: "already-running" });
  });

  it("a new plan is deployed whatever compose reports, and records what it reported", () => {
    expect(foldApp(APP, "new", allBut("route", converged()))).toMatchObject({ status: "deployed", convergeAction: "already-running" });
  });

  it("a project that could not be observed is unchanged with the reason, never deployed or failed", () => {
    const row = foldApp(APP, "new", allBut("project", unobservable("no socket")));
    expect(row).toMatchObject({ status: "unchanged", convergeAction: "unknown", unknownReason: "no socket" });
    expect(row.error).toBeUndefined();
  });

  it("a route that did not land after a converged project is a partial converge", () => {
    const row = foldApp(APP, "changed", allBut("route", diverged("edge not running", "unavailable"), converged("started")));
    expect(row).toMatchObject({ status: "failed", error: "edge not running", containerStartedWithoutRoutes: true });
  });

  it("a render, secrets or pre-shepherd failure is a plain failure carrying the detail", () => {
    expect(foldApp(APP, "new", allBut("render", diverged("disk full")))).toMatchObject({ status: "failed", error: "disk full" });
    expect(foldApp(APP, "new", allBut("secrets", diverged("DB_PASS: no provider")))).toMatchObject({ status: "failed", error: "DB_PASS: no provider" });
    expect(foldApp(APP, "new", allBut("shepherd:pre", diverged("Pre-deploy shepherd failed: x")))).toMatchObject({ status: "failed", error: "Pre-deploy shepherd failed: x" });
  });

  it("a post-shepherd failure is recorded and does not fail the app", () => {
    const row = foldApp(APP, "new", allBut("shepherd:post", diverged("hook: exit 1")));
    expect(row).toMatchObject({ status: "deployed", shepherdErrors: ["hook: exit 1"] });
  });

  it("an app that only has a compile verdict failed at compile", () => {
    expect(foldApp(APP, "new", verdicts([["compile", diverged("did not compile")]]))).toMatchObject({ status: "failed", error: "did not compile" });
  });

  it("a skipped render names the dependency", () => {
    const row = foldApp(APP, "new", verdicts([["render", diverged("skipped: depends on db, which did not become ready", "skipped")]]));
    expect(row).toMatchObject({ status: "failed", error: "skipped: depends on db, which did not become ready" });
  });
});

describe("foldDeployResult: the counts are the tally of the rows", () => {
  it("deployed + unchanged + failed is the number of apps; partial converges are counted apart", () => {
    const v = new Map<string, Verdict>([
      [convergeId("a", "project"), converged("started")],
      [convergeId("b", "project"), converged("already-running")],
      [convergeId("c", "project"), converged("started")], [convergeId("c", "route"), diverged("no edge", "unavailable")],
    ]);
    const r = foldDeployResult([{ appName: "a", planStatus: "unchanged" }, { appName: "b", planStatus: "unchanged" }, { appName: "c", planStatus: "new" }], v, { compileErrors: [] });
    expect([r.deployed, r.unchanged, r.failed, r.startedButUnrouted]).toEqual([1, 1, 1, 1]);
    expect(r.apps.map((a) => a.appName)).toEqual(["a", "b", "c"]);
  });
});

describe("runConverges: the one skip rule", () => {
  const ctx = {} as DeployContext;
  const link = (app: string, kind: Parameters<typeof convergeId>[1], dependsOn: string[], v: Verdict, ran: string[]): Converge =>
    ({ id: convergeId(app, kind), app, kind, dependsOn, run: async () => { ran.push(convergeId(app, kind)); return v; } });

  it("an unobservable dependency blocks its dependents, with the dependency named", async () => {
    const ran: string[] = [];
    const out = await runConverges([
      link("db", "project", [], unobservable("socket down"), ran),
      link("web", "render", [convergeId("db", "project")], converged(), ran),
      link("web", "project", [convergeId("web", "render")], converged("started"), ran),
    ], ctx);
    expect(out.get(convergeId("web", "render"))).toEqual(diverged("skipped: depends on db, which did not become ready", "skipped"));
    expect(out.get(convergeId("web", "project"))).toMatchObject({ kind: "diverged", reason: "skipped" });
    expect(ran).toEqual([convergeId("db", "project")]);
  });

  it("a dependency that never emitted a project (compile error) is unmet", async () => {
    const ran: string[] = [];
    const out = await runConverges([link("web", "render", [convergeId("db", "project")], converged(), ran)], ctx);
    expect(out.get(convergeId("web", "render"))).toMatchObject({ detail: "skipped: depends on db, which did not become ready" });
    expect(ran).toEqual([]);
  });

  it("within an app, a failed link skips the rest of the chain and names the link", async () => {
    const ran: string[] = [];
    const out = await runConverges([
      link("web", "render", [], diverged("disk full"), ran),
      link("web", "project", [convergeId("web", "render")], converged(), ran),
    ], ctx);
    expect(out.get(convergeId("web", "project"))).toEqual(diverged("skipped: web/render did not converge", "skipped"));
  });
});
