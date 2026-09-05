/**
 * System app boot ordering — the sequence `appbay up` deploys in and `appbay down` reverses.
 *
 * ⚠️ This module had no tests, and it decides deployment order for the edge proxy: the app
 * every other app routes through. The properties below are the ones callers actually rely
 * on, and two of them are easy to break by accident because they concern ORDER, which a
 * type checker cannot see and a smoke test with one system app installed cannot distinguish.
 */

import { describe, expect, it } from "vitest";
import {
  SYSTEM_APP_BOOT_ORDER,
  isSystemApp,
  partitionByBootOrder,
  sortByDeployOrder,
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

describe("partitionByBootOrder", () => {
  it("returns system apps in BOOT order regardless of input order", () => {
    // The input here is alphabetical, which is what `discoverApps` produces — it sorts by
    // name. Boot order is not alphabetical, so a caller that trusts input order is wrong.
    const { system } = partitionByBootOrder(["caddy", "litellm", "traefik"]);
    expect(system).toEqual([...SYSTEM_APP_BOOT_ORDER]);
    expect(system).not.toEqual(["caddy", "traefik"]); // i.e. not the alphabetical order
  });

  it("preserves user app order", () => {
    const { user } = partitionByBootOrder(["zed", "traefik", "apple"]);
    expect(user).toEqual(["zed", "apple"]);
  });

  it("omits system apps that are not installed", () => {
    const { system } = partitionByBootOrder(["caddy", "litellm"]);
    expect(system).toEqual(["caddy"]);
  });

  it("does not invent apps that were not passed in", () => {
    const { system, user } = partitionByBootOrder([]);
    expect(system).toEqual([]);
    expect(user).toEqual([]);
  });
});

describe("sortByDeployOrder", () => {
  const app = (appName: string) => ({ appName });

  it("puts system apps first, in boot order, then user apps in original order", () => {
    const sorted = sortByDeployOrder([
      app("litellm"),
      app("caddy"),
      app("openwebui"),
      app("traefik"),
    ]);
    expect(sorted.map((a) => a.appName)).toEqual([
      ...SYSTEM_APP_BOOT_ORDER,
      "litellm",
      "openwebui",
    ]);
  });

  it("does not drop or duplicate anything", () => {
    const input = [app("a"), app("traefik"), app("b"), app("caddy")];
    const sorted = sortByDeployOrder(input);
    expect(sorted).toHaveLength(input.length);
    expect([...sorted.map((a) => a.appName)].sort()).toEqual(
      [...input.map((a) => a.appName)].sort(),
    );
  });

  it("is a new array — the caller's list is untouched", () => {
    const input = [app("litellm"), app("traefik")];
    const sorted = sortByDeployOrder(input);
    expect(sorted).not.toBe(input);
    expect(input.map((a) => a.appName)).toEqual(["litellm", "traefik"]);
  });
});

describe("teardown is the reverse of boot", () => {
  it("reversing the PARTITIONED system list is not the same as reversing the input", () => {
    // 🚨 The bug this pins. `appbay down` built its order as
    // `targetApps.filter(isSystemApp).reverse()`, and targetApps comes from `discoverApps`,
    // which sorts ALPHABETICALLY. Reversing an alphabetical list is not reverse-boot-order:
    // with both providers present it yielded [traefik, caddy] — boot order, the exact
    // opposite of the intent stated in the comment above it.
    const discovered = ["caddy", "litellm", "traefik"]; // alphabetical, as discovery returns

    const naive = discovered.filter(isSystemApp).reverse();
    const correct = [...partitionByBootOrder(discovered).system].reverse();

    expect(correct).toEqual([...SYSTEM_APP_BOOT_ORDER].reverse());
    expect(naive).not.toEqual(correct);
  });
});

describe("deployOrder — collections.yaml expanded to app edges (S39, option C)", async () => {
  const { deployOrder, dependentsOf } = await import("../boot-order.js");
  const app = (appName: string, ...collections: string[]) => ({ appName, collections: collections.length ? collections : ["default"] });

  it("with no file, system apps come first and user apps keep their order", () => {
    const r = deployOrder([app("zeta"), app("caddy"), app("alpha")]);
    expect(r.errors).toEqual([]);
    expect(r.order.map((a) => a.appName)).toEqual(["caddy", "zeta", "alpha"]);
  });

  it("starts every app of an `after` collection before any app of the dependent one", () => {
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

  it("an app in both collections takes every edge and never depends on itself", () => {
    const r = deployOrder([app("vectordb", "data", "ai"), app("webui", "ai")], { ai: { after: ["data"] } });
    expect(r.errors).toEqual([]);
    expect(r.order.map((a) => a.appName)).toEqual(["vectordb", "webui"]);
    expect(r.dependsOn.get("vectordb")!.has("vectordb")).toBe(false);
  });

  it("refuses a cycle, naming the apps", () => {
    const r = deployOrder([app("a", "x"), app("b", "y")], { x: { after: ["y"] }, y: { after: ["x"] } });
    expect(r.errors.join("\n")).toMatch(/cycle among: a, b/);
  });

  it("refuses an `after` that names a collection nothing declares", () => {
    const r = deployOrder([app("a", "x")], { x: { after: ["ghost"] } });
    expect(r.errors[0]).toContain('"ghost"');
  });
});
