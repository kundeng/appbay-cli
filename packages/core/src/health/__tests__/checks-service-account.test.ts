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
import { checkServiceAccountRuntimeAccess, probeArgv } from "../checks.js";
import { podmanRootfulEnv } from "../../runtime/podman-rootful.js";

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
    expect(r.fix).toMatch(/sudo -n -u appbay/);
  });

  it("names the remedy, now that there IS one", () => {
    // Before S34 this text ENUMERATED the causes ($HOME, subuid, socket permission), because
    // no command fixed them. `init-system` now does, so listing causes would leave the
    // operator diagnosing something already solved.
    const r = check("appbay", "kundeng", "denied");
    expect(r.fix).toMatch(/appbay init-system/);
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
});

/**
 * 🚨 THE PROBE AND THE RUNNER MUST ASK THE SAME QUESTION.
 *
 * `sudo -n -u appbay podman info` runs with a reset environment, and podman with no
 * CONTAINER_HOST goes ROOTLESS — while the systemd unit that runs the control plane points at
 * the ROOTFUL socket. Left alone, this check would have started reporting `denied` on hosts
 * that S34 configured correctly: the same "confident answer to a question nobody asked" the
 * check was written to remove, pointing the other way.
 */
describe("the probe argv", () => {
  it("carries the rootful environment on podman", () => {
    const argv = probeArgv("/usr/bin/podman", HOME);
    expect(argv[0]).toBe("env");
    expect(argv).toContain(`HOME=${HOME}`);
    expect(argv).toContain("CONTAINER_HOST=unix:///run/podman/podman.sock");
  });

  it("uses the SAME environment the unit renders, not a second copy of it", () => {
    // If these two ever drift, nothing errors — the checker exercises one code path and the
    // runner another, and the disagreement surfaces as a false verdict.
    const argv = probeArgv("/usr/bin/podman", HOME);
    for (const [k, v] of Object.entries(podmanRootfulEnv(HOME))) {
      expect(argv).toContain(`${k}=${v}`);
    }
  });

  it("adds nothing on docker — group membership IS the mechanism there", () => {
    // `docker info` with a bare environment is exactly what the daemon sees. Wrapping it in
    // `env HOME=…` would make the probe diverge from the runner in the other direction.
    const argv = probeArgv("/usr/bin/docker", HOME);
    expect(argv[0]).toBe("/usr/bin/docker");
    expect(argv.join(" ")).not.toMatch(/CONTAINER_HOST/);
  });

  it("asks for a version, not for exit 0", () => {
    // `tryExec` returns null on EMPTY stdout even at exit 0, and a probe that prints nothing
    // reads as failure. This bit the sudo probe once already (`sudo -n true`).
    expect(probeArgv("/usr/bin/podman", HOME).join(" ")).toContain("--format");
  });

  it("🚨 asks podman for a field podman HAS", () => {
    // `{{.ServerVersion}}` is a DOCKER field. podman's report is `system.infoReport` and the
    // template errors (exit 125), so `tryExec` returns null and the check reports `denied` on
    // every podman host regardless of access — the inversion this module exists to prevent,
    // which shipped anyway because unifying the environment left the argv docker-shaped:
    //   Error: template: info:1:2: can't evaluate field ServerVersion in type system.infoReport
    const argv = probeArgv("/usr/bin/podman", HOME).join(" ");
    expect(argv).toContain("{{.Version.Version}}");
    expect(argv).not.toContain("ServerVersion");
  });

  it("still asks docker for the docker field", () => {
    expect(probeArgv("/usr/bin/docker", HOME).join(" ")).toContain("{{.ServerVersion}}");
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
