/**
 * `findContainerByLabel` is how the deploy path finds the edge. Before it existed the edge
 * was a literal `appbay.caddy.caddy`, which the system namespace renamed to
 * `appbay.system.caddy.caddy`, and every ingress app on a caddy host reported its routes
 * as not installed (review 2026-09-05, F0). A label survives a rename; a literal does not.
 */
import { describe, it, expect } from "vitest";
import { findContainerByLabel, type ContainerRunner } from "../container-runtime.js";

const runner = (exitCode: number, output: string): ContainerRunner => () => ({ exitCode, output });

describe("findContainerByLabel", () => {
  it("asks ps -a with the label filter and the names/state template", () => {
    let seen: string[] = [];
    findContainerByLabel("com.appbay.app", "caddy", { run: (args) => { seen = args; return { exitCode: 0, output: "" }; } });
    expect(seen).toEqual(["ps", "-a", "--filter", "label=com.appbay.app=caddy", "--format", "{{.Names}}\t{{.State}}"]);
  });

  it("returns the running container, whatever its name", () => {
    const r = findContainerByLabel("com.appbay.app", "caddy", { run: runner(0, "appbay.system.caddy.caddy\trunning\n") });
    expect(r).toEqual({ kind: "ok", value: { name: "appbay.system.caddy.caddy", state: "running", running: true } });
  });

  it("reports a stopped container as found and not running", () => {
    const r = findContainerByLabel("com.appbay.app", "caddy", { run: runner(0, "appbay.system.caddy.caddy\texited\n") });
    expect(r).toEqual({ kind: "ok", value: { name: "appbay.system.caddy.caddy", state: "exited", running: false } });
  });

  it("returns ok(null) when nothing carries the label", () => {
    expect(findContainerByLabel("com.appbay.app", "caddy", { run: runner(0, "\n") })).toEqual({ kind: "ok", value: null });
  });

  it("returns unknown, not null, when ps could not run", () => {
    const r = findContainerByLabel("com.appbay.app", "caddy", { run: runner(1, "Cannot connect to the Docker daemon") });
    expect(r.kind).toBe("unknown");
    if (r.kind === "unknown") expect(r.reason).toContain("Cannot connect");
  });

  it("prefers the running one when an old container is stopped beside it", () => {
    const r = findContainerByLabel("com.appbay.app", "caddy", {
      run: runner(0, "appbay.caddy.caddy\texited\nappbay.system.caddy.caddy\trunning\n"),
    });
    expect(r).toMatchObject({ kind: "ok", value: { name: "appbay.system.caddy.caddy", running: true } });
  });

  it("refuses to pick between two running edges", () => {
    const r = findContainerByLabel("com.appbay.app", "caddy", {
      run: runner(0, "appbay.caddy.caddy\trunning\nappbay.system.caddy.caddy\trunning\n"),
    });
    expect(r.kind).toBe("unknown");
    if (r.kind === "unknown") expect(r.reason).toMatch(/2 running.*appbay\.caddy\.caddy.*appbay\.system\.caddy\.caddy/);
  });
});
