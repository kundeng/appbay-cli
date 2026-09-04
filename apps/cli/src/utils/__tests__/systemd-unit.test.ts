/**
 * The control-plane systemd unit — RFC-001 S33.
 *
 * ⭐ EVERY ASSERTION HERE IS A FAILURE MODE, NOT A FORMAT CHECK. A systemd unit is accepted by
 * `systemd-analyze verify` in shapes that then behave wrongly at runtime: the wrong `Type=`
 * restarts a healthy service forever, a missing `Environment=` silently resolves a different
 * home, and `Requires=` on the runtime takes the control plane down with it.
 */

import { describe, expect, it } from "vitest";
import { podmanRootfulEnv } from "@appbay/core";
import { renderServerUnit, SERVER_UNIT_NAME, SERVER_UNIT_PATH } from "../systemd-unit.js";

const BASE = {
  binaryPath: "/usr/local/bin/appbay",
  home: "/var/lib/appbay",
  runtimeUnit: "docker.service",
};

describe("the parts that decide runtime behaviour", () => {
  it("🚨 is Type=oneshot with RemainAfterExit — `server start` exits when the stack is up", () => {
    // With Type=simple systemd would consider the service dead the moment the command
    // returned and restart it forever, tearing the compose stack up and down in a loop.
    const unit = renderServerUnit(BASE);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("RemainAfterExit=yes");
    expect(unit).not.toContain("Type=simple");
  });

  it("🚨 states APPBAY_HOME — systemd starts services with almost no environment", () => {
    // No login shell, no profile. Without this the unit resolves the home from the tiers
    // below and can land on `~/.appbay` of whatever user it runs as.
    expect(renderServerUnit(BASE)).toContain("Environment=APPBAY_HOME=/var/lib/appbay");
  });

  it("🚨 orders after the runtime but does not Require it", () => {
    // `Requires=` propagates a stop: restarting docker would take the control plane down with
    // it, which is not what "the stack needs the socket to exist at start" means.
    const unit = renderServerUnit(BASE);
    expect(unit).toContain("After=network-online.target docker.service");
    expect(unit).toContain("Wants=network-online.target docker.service");
    expect(unit).not.toMatch(/^Requires=/m);
  });

  it("🚨 on podman + a service account, states HOME and CONTAINER_HOST", () => {
    // Without these the unit starts, reaches ExecStart, and fails there — probe-87.
    //   HOME: systemd sets it from the passwd entry, and the D-6 account is --no-create-home,
    //         so that path does not exist. podman refuses before it tries to connect.
    //   CONTAINER_HOST: podman run by a NON-ROOT user defaults to ROOTLESS. Without this, the
    //         socket group init-system grants is never touched — measured in probe-89, where
    //         `ls -l` showed a correctly granted socket and podman still failed on subuid.
    const unit = renderServerUnit({ ...BASE, runtimeUnit: "podman.socket", user: "appbay" });
    expect(unit).toContain("Environment=HOME=/var/lib/appbay");
    expect(unit).toContain("Environment=CONTAINER_HOST=unix:///run/podman/podman.sock");
  });

  it("uses the SAME environment the doctor probe uses", () => {
    // One record, two renderings. If they drift, the checker exercises a different code path
    // from the runner and reports confidently about a question nobody asked.
    const unit = renderServerUnit({ ...BASE, runtimeUnit: "podman.socket", user: "appbay" });
    for (const [k, v] of Object.entries(podmanRootfulEnv(BASE.home))) {
      expect(unit).toContain(`Environment=${k}=${v}`);
    }
  });

  it("adds neither on docker — the group membership IS the mechanism there", () => {
    const unit = renderServerUnit({ ...BASE, user: "appbay" });
    expect(unit).not.toContain("CONTAINER_HOST");
    expect(unit).not.toMatch(/^Environment=HOME=/m);
  });

  it("adds neither on an operator install, even on podman", () => {
    // That user's rootless podman works. Forcing them onto the rootful socket would break a
    // setup that is fine, and they have no group on it anyway.
    const unit = renderServerUnit({ ...BASE, runtimeUnit: "podman.socket" });
    expect(unit).not.toContain("CONTAINER_HOST");
  });

  it("uses the runtime unit it is given — podman is a socket, not a service", () => {
    // `podman.service` does not exist; enabling or ordering against it would silently do
    // nothing. The caller resolves which one, this must not hardcode either.
    const unit = renderServerUnit({ ...BASE, runtimeUnit: "podman.socket" });
    expect(unit).toContain("After=network-online.target podman.socket");
    expect(unit).not.toContain("docker.service");
  });

  it("invokes the binary by ABSOLUTE path — a unit has no useful PATH", () => {
    const unit = renderServerUnit(BASE);
    expect(unit).toContain("ExecStart=/usr/local/bin/appbay server start");
    expect(unit).toContain("ExecStop=/usr/local/bin/appbay server stop");
    expect(unit).not.toMatch(/ExecStart=appbay/);
  });

  it("allows a long start — a cold image pull is not a hang", () => {
    // The default 90s would fail a first boot that has to pull the server image.
    expect(renderServerUnit(BASE)).toContain("TimeoutStartSec=300");
  });
});

describe("who it runs as", () => {
  it("runs as the service account on a service install", () => {
    expect(renderServerUnit({ ...BASE, user: "appbay" })).toContain("User=appbay");
  });

  it("omits User entirely on an operator install", () => {
    // The invoking user owns the tree there; pinning a User= would run it as somebody who
    // cannot read the home.
    expect(renderServerUnit(BASE)).not.toMatch(/^User=/m);
  });
});

describe("what it says about itself", () => {
  it("⚠️ states that it does NOT make /etc/appbay/config removable", () => {
    // RFC-001 2.7's premise, refuted in probe-86. The next person to read this unit will be
    // wondering exactly that, and the answer belongs where they are looking.
    const unit = renderServerUnit(BASE);
    expect(unit).toContain("/etc/appbay/config");
    expect(unit).toMatch(/probe-86/);
  });

  it("is installed where systemd looks, under a name matching the path", () => {
    expect(SERVER_UNIT_PATH).toBe(`/etc/systemd/system/${SERVER_UNIT_NAME}`);
    expect(SERVER_UNIT_NAME.endsWith(".service")).toBe(true);
  });

  it("declares [Unit], [Service] and [Install], in that order", () => {
    const unit = renderServerUnit(BASE);
    expect(unit.indexOf("[Unit]")).toBeGreaterThan(-1);
    expect(unit.indexOf("[Unit]")).toBeLessThan(unit.indexOf("[Service]"));
    expect(unit.indexOf("[Service]")).toBeLessThan(unit.indexOf("[Install]"));
    // Without [Install]/WantedBy, `systemctl enable` reports success and links nothing.
    expect(unit).toContain("WantedBy=multi-user.target");
  });
});
