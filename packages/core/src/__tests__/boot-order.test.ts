/**
 * System app boot ordering — the sequence `appbay up` deploys in and `appbay down` reverses.
 *
 * This module decides deployment order for the edge proxy, the app every other app routes
 * through. The properties below are the ones callers rely on, and the ones about ORDER are
 * easy to break by accident: a type checker cannot see order, and a smoke test with one
 * system app installed cannot distinguish it.
 */

import { describe, expect, it } from "vitest";
import {
  SYSTEM_APP_BOOT_ORDER,
  isSystemApp,
  deployOrder,
  dependentsOf,
} from "../boot-order.js";

describe("isSystemApp", () => {
  it("recognises both ingress providers", () => {
    // 🚨 `caddy` was once missing here, which made the proxy a USER app on a caddy
    // installation — deployable after the apps routing through it.
    expect(isSystemApp("traefik")).toBe(true);
    expect(isSystemApp("caddy")).toBe(true);
  });

  it("treats anything else as a user app", () => {
    expect(isSystemApp("litellm")).toBe(false);
    expect(isSystemApp("")).toBe(false);
  });
});

describe("teardown is the reverse of boot", () => {
  it("reversing the deploy order is not the same as reversing the input", () => {
    // 🚨 The bug this pins. `appbay down` built its order as
    // `targetApps.filter(isSystemApp).reverse()`, and targetApps comes from `discoverApps`,
    // which sorts ALPHABETICALLY. Reversing an alphabetical list is not reverse-boot-order:
    // with both providers present it yielded [traefik, caddy] — boot order, the exact
    // opposite of the intent stated in the comment above it.
    const discovered = ["caddy", "litellm", "traefik"]; // alphabetical, as discovery returns

    const naive = discovered.filter(isSystemApp).reverse();
    const ordered = deployOrder(discovered.map((appName) => ({ appName, project: "default" }))).order.map((a) => a.appName);
    const correct = [...ordered.filter(isSystemApp)].reverse();

    expect(correct).toEqual([...SYSTEM_APP_BOOT_ORDER].reverse());
    expect(naive).not.toEqual(correct);
  });
});

describe("deployOrder — projects.yaml expanded to app edges", () => {
  const app = (appName: string, project = "default") => ({ appName, project });

  it("with no file, system apps come first and user apps keep their order", () => {
    const r = deployOrder([app("zeta"), app("caddy"), app("alpha")]);
    expect(r.errors).toEqual([]);
    expect(r.order.map((a) => a.appName)).toEqual(["caddy", "zeta", "alpha"]);
  });

  it("starts every app of an `after` project before any app of the dependent one", () => {
    const r = deployOrder(
      [app("webui", "ai"), app("pg", "data"), app("redis", "data"), app("ollama", "ai")],
      { ai: { after: ["data"] }, data: { after: [] } },
    );
    expect(r.errors).toEqual([]);
    const names = r.order.map((a) => a.appName);
    expect(names.indexOf("pg")).toBeLessThan(names.indexOf("webui"));
    expect(names.indexOf("redis")).toBeLessThan(names.indexOf("ollama"));
    expect([...r.dependsOn.get("webui")!]).toEqual(expect.arrayContaining(["pg", "redis"]));
    expect(dependentsOf("pg", r.dependsOn)).toEqual(new Set(["webui", "ollama"]));
  });

  it("refuses a cycle, naming the apps", () => {
    const r = deployOrder([app("a", "x"), app("b", "y")], { x: { after: ["y"] }, y: { after: ["x"] } });
    expect(r.errors.join("\n")).toMatch(/cycle among: a, b/);
  });

  it("refuses an `after` that names a project nothing declares", () => {
    const r = deployOrder([app("a", "x")], { x: { after: ["ghost"] } });
    expect(r.errors.join("\n")).toContain("ghost");
    // `appbay up a` with project y declared by an installed app outside the target set is not a ghost (S48).
    const partial = deployOrder([app("a", "x")], { x: { after: ["y"] } }, ["y"]);
    expect(partial.errors).toEqual([]);
    expect(partial.order.map((o) => o.appName)).toEqual(["a"]);
    expect(r.errors[0]).toContain('"ghost"');
  });
});
