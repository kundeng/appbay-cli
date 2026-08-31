/**
 * `checkServiceAccountRuntimeAccess` — does the account that RUNS the control plane have
 * runtime access? S34 requirement 2.2.
 *
 * ⭐ THE POINT IS THE PRINCIPAL, NOT THE PROBE. `checkDockerAccessible` already answers "can
 * the current user reach the runtime". On a service install that is the wrong person: the tree
 * is owned by a no-login account that the systemd unit runs as, and the operator running
 * `appbay doctor` is somebody else. Doctor therefore reported a healthy runtime while the
 * account that mattered could not reach it — measured on Fedora 43 in probe-87/88, where the
 * failure only surfaced later as `appbay server start` exiting 1.
 *
 * ⚠️ Dependencies are injected rather than mocked at the module boundary, because the thing
 * under test is a DECISION about three inputs (who owns the tree, who is asking, what the probe
 * said). Driving it through spawnSync would test the plumbing and leave the decision implicit.
 */

import { describe, expect, it } from "vitest";
import { checkServiceAccountRuntimeAccess } from "../checks.js";

const HOME = "/var/lib/appbay";

function check(
  owner: string | null,
  me: string | null,
  probe: "ok" | "denied" | "cannot-probe" = "ok",
) {
  return checkServiceAccountRuntimeAccess(HOME, {
    ownerOf: () => owner,
    currentUser: () => me,
    probe: () => probe,
  });
}

describe("an operator install", () => {
  it("skips — the account that runs it is the one asking", () => {
    const r = check("kundeng", "kundeng");
    expect(r.passed).toBe(true);
    expect(r.detail).toContain("runs as you");
  });
});

describe("a service install", () => {
  it("passes when the owning account can reach the runtime", () => {
    const r = check("appbay", "kundeng", "ok");
    expect(r.passed).toBe(true);
    expect(r.detail).toContain("appbay");
  });

  it("🚨 FAILS when the owning account cannot — the case doctor used to call healthy", () => {
    const r = check("appbay", "kundeng", "denied");
    expect(r.passed).toBe(false);
    // The detail must name the principal, or the operator reads it as their own problem and
    // "fixes" their own group membership, which was never wrong.
    expect(r.detail).toContain("appbay");
    expect(r.detail).toMatch(/runs as appbay, not as you/);
  });

  it("gives a fix that reproduces it as the right user", () => {
    // A fix an operator cannot run is not a fix. `sudo -u <owner>` is what probe-87 used.
    const r = check("appbay", "kundeng", "denied");
    expect(r.fix).toMatch(/sudo -u appbay/);
  });

  it("names both causes, and which one defeats either access model", () => {
    // probe-88: the missing $HOME fails before the connection is attempted, so pointing at
    // the rootful socket does not avoid it. An operator told only "no access" would start
    // with subuid and get nowhere.
    const r = check("appbay", "kundeng", "denied");
    expect(r.fix).toMatch(/--no-create-home|\$HOME/);
    expect(r.fix).toMatch(/subuid/);
  });
});

describe("🚨 when it cannot tell, it must not say pass", () => {
  it("reports that it could not verify, rather than claiming access is fine", () => {
    // Probing another account needs passwordless sudo. Reporting a clean pass here would be
    // the same false green this check exists to remove.
    const r = check("appbay", "kundeng", "cannot-probe");
    expect(r.detail).toMatch(/cannot verify/);
    expect(r.detail).not.toMatch(/can reach/);
    expect(r.fix).toMatch(/sudo -u appbay/);
  });

  it("skips when the owner cannot be determined at all", () => {
    expect(check(null, "kundeng").detail).toContain("cannot determine");
    expect(check("appbay", null).detail).toContain("cannot determine");
  });
});

describe("it never blocks", () => {
  it("is not required — an operator install has no second account", () => {
    // `required: true` would fail `appbay doctor` on every personal install and on any host
    // without passwordless sudo, neither of which is broken.
    for (const p of ["ok", "denied", "cannot-probe"] as const) {
      expect(check("appbay", "kundeng", p).required).toBe(false);
    }
    expect(check("kundeng", "kundeng").required).toBe(false);
  });
});
