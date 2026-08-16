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
