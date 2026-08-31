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
