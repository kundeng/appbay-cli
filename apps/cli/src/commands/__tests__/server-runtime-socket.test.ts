import { describe, expect, it } from "vitest";
import { runtimeSocketFor } from "../server.js";

describe("runtimeSocketFor", () => {
  it("uses the Docker socket for a Docker host", () => {
    expect(runtimeSocketFor("docker", 1000)).toBe("/var/run/docker.sock");
  });

  it("uses the system socket for rootful Podman", () => {
    expect(runtimeSocketFor("podman", 0)).toBe("/run/podman/podman.sock");
  });

  it("uses the user socket for rootless Podman", () => {
    expect(runtimeSocketFor("podman", 501, "/run/user/501")).toBe(
      "/run/user/501/podman/podman.sock",
    );
  });

  it("honors an explicit nonstandard socket", () => {
    expect(runtimeSocketFor("podman", 0, undefined, "/srv/podman.sock")).toBe(
      "/srv/podman.sock",
    );
  });
});

/**
 * 🚨 THE NON-ROOT ACCOUNT ON THE ROOTFUL SOCKET — S34.
 *
 * Until S34 "uid 0" and "rootful socket" were the same thing, so the uid test answered both
 * questions. The D-6 service account is uid 950 and now talks to the ROOTFUL socket via
 * CONTAINER_HOST, and the uid test computed a rootless path that does not exist. Measured:
 * the control plane died with `statfs /run/user/950/podman/podman.sock: no such file or
 * directory` on a host where the account could otherwise reach podman perfectly.
 */
describe("when CONTAINER_HOST says which socket", () => {
  it("🚨 uses it for a NON-ROOT uid, instead of guessing a rootless path", () => {
    expect(
      runtimeSocketFor("podman", 950, undefined, undefined, "unix:///run/podman/podman.sock"),
    ).toBe("/run/podman/podman.sock");
  });

  it("is outranked by an explicit APPBAY_RUNTIME_SOCKET", () => {
    expect(
      runtimeSocketFor("podman", 950, undefined, "/srv/x.sock", "unix:///run/podman/podman.sock"),
    ).toBe("/srv/x.sock");
  });

  it("ignores a REMOTE CONTAINER_HOST rather than mounting a local path that is not it", () => {
    // tcp:// and ssh:// say the socket is not on this host. Slicing a path out of them would
    // mount something unrelated; falling through to the uid guess at least fails loudly.
    for (const host of ["tcp://10.0.0.5:2375", "ssh://user@box/run/podman/podman.sock"]) {
      expect(runtimeSocketFor("podman", 950, "/run/user/950", undefined, host)).toBe(
        "/run/user/950/podman/podman.sock",
      );
    }
  });

  it("does not affect a docker install", () => {
    expect(
      runtimeSocketFor("docker", 950, undefined, undefined, "unix:///run/podman/podman.sock"),
    ).toBe("/var/run/docker.sock");
  });

  it("leaves a rootless operator install exactly as it was", () => {
    // No CONTAINER_HOST is the operator case: the unit only sets it for a service account.
    expect(runtimeSocketFor("podman", 501, "/run/user/501")).toBe(
      "/run/user/501/podman/podman.sock",
    );
  });
});
