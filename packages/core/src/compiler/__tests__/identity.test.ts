/**
 * Generated identity — RFC-001 §4.4 and §4.5.
 *
 * Two properties carry the weight here. The un-namespaced output must be byte-identical to
 * what appbay produced before §4, or every existing host silently renames its containers on
 * the next converge and orphans what is running. And the namespace must be DNS-folded
 * everywhere it reaches a hostname, because a dot is the label separator.
 */

import { describe, expect, it } from "vitest";
import {
  dnsSafe,
  containerName,
  sharedNetworkAlias,
  internalNetworkName,
  auxFileStem,
} from "../identity.js";

describe("dnsSafe", () => {
  it("folds dots to hyphens — a dot is a DNS label separator", () => {
    expect(dnsSafe("uom.sim")).toBe("uom-sim");
    expect(dnsSafe("a.b.c")).toBe("a-b-c");
  });

  it("leaves a namespace with no dots alone", () => {
    expect(dnsSafe("staging")).toBe("staging");
  });
});

describe("un-namespaced output is unchanged from before RFC-001 §4", () => {
  // 🚨 If any of these change, every container and network on every existing host is
  // renamed by the next converge. All 155 manifests in both catalogs declare no namespace,
  // so this is the common case, not the edge case.
  for (const ns of [undefined, "default", ""]) {
    it(`namespace=${JSON.stringify(ns)} produces the legacy names`, () => {
      expect(containerName(ns, "litellm", "litellm")).toBe("appbay.litellm.litellm");
      expect(sharedNetworkAlias(ns, "litellm", "litellm")).toBe("litellm_litellm");
      expect(internalNetworkName(ns, "litellm")).toBe("litellm_internal");
      expect(auxFileStem(ns, "litellm")).toBe("litellm");
    });
  }
});

describe("a real namespace enters identity, DNS-folded", () => {
  it("container name carries the folded namespace", () => {
    expect(containerName("uom.sim", "litellm", "litellm")).toBe(
      "appbay.uom-sim.litellm.litellm",
    );
  });

  it("the shared-network alias is a single DNS label per segment", () => {
    const alias = sharedNetworkAlias("uom.sim", "litellm", "litellm");
    expect(alias).toBe("uom-sim_litellm_litellm");
    // The bug this exists to prevent: with the dot left in, `uom.sim_litellm_litellm`
    // parses as host `uom` in domain `sim_litellm_litellm` and resolves to nothing.
    expect(alias).not.toContain(".");
  });

  it("network and aux stem carry it too", () => {
    expect(internalNetworkName("uom.sim", "litellm")).toBe("uom-sim_litellm_internal");
    expect(auxFileStem("uom.sim", "litellm")).toBe("uom-sim.litellm");
  });

  it("two namespaces of one app produce distinct identity at every level", () => {
    // This is the point of §4.4: two instances coexisting in one home.
    const sim = {
      container: containerName("uom.sim", "litellm", "litellm"),
      alias: sharedNetworkAlias("uom.sim", "litellm", "litellm"),
      network: internalNetworkName("uom.sim", "litellm"),
      aux: auxFileStem("uom.sim", "litellm"),
    };
    const prod = {
      container: containerName("uom.prod", "litellm", "litellm"),
      alias: sharedNetworkAlias("uom.prod", "litellm", "litellm"),
      network: internalNetworkName("uom.prod", "litellm"),
      aux: auxFileStem("uom.prod", "litellm"),
    };
    for (const key of Object.keys(sim) as Array<keyof typeof sim>) {
      expect(sim[key]).not.toBe(prod[key]);
    }
  });
});
