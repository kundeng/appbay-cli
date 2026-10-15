import { describe, it, expect } from "vitest";
import { resolveEndpointFrom, parseHost, endpointEnv, describeEndpoint, type ContextHost, type EndpointInputs } from "../endpoint.js";

const contexts: Record<string, ContextHost> = {
  remote: { ok: true, host: "ssh://ops@server.example:2222", tls: false },
  local: { ok: true, host: "unix:///Users/me/.orbstack/run/docker.sock", tls: false },
  secured: { ok: true, host: "tcp://10.0.0.5:2376", tls: true },
};

function inputs(over: Partial<EndpointInputs> & { current?: string } = {}): EndpointInputs {
  const { current, ...rest } = over;
  return {
    runtime: "docker",
    env: {},
    uid: 501,
    readContext: (name) => {
      const key = name ?? current;
      if (!key) return { ok: false, reason: "no current docker context" };
      return contexts[key] ?? { ok: false, reason: `context "${key}" does not exist` };
    },
    ...rest,
  };
}

describe("resolveEndpointFrom: one answer, in Docker's order", () => {
  it("APPBAY_RUNTIME_SOCKET wins over everything", () => {
    const e = resolveEndpointFrom(inputs({ env: { APPBAY_RUNTIME_SOCKET: "/tmp/a.sock", DOCKER_HOST: "ssh://x@y", DOCKER_CONTEXT: "remote" }, configured: "tcp://h:1" }));
    expect(e).toEqual({ kind: "unix", path: "/tmp/a.sock", source: "APPBAY_RUNTIME_SOCKET" });
  });

  it("DOCKER_HOST wins over DOCKER_CONTEXT, as the Docker CLI ranks them", () => {
    const e = resolveEndpointFrom(inputs({ env: { DOCKER_HOST: "unix:///var/run/other.sock", DOCKER_CONTEXT: "remote" } }));
    expect(e).toMatchObject({ kind: "unix", path: "/var/run/other.sock", source: "DOCKER_HOST" });
  });

  it("DOCKER_CONTEXT wins over the configured endpoint and names the context's host", () => {
    const e = resolveEndpointFrom(inputs({ env: { DOCKER_CONTEXT: "remote" }, configured: "unix:///configured.sock", current: "local" }));
    expect(e).toEqual({ kind: "ssh", url: "ssh://ops@server.example:2222", destination: "ops@server.example", port: 2222, source: "DOCKER_CONTEXT" });
  });

  it("the configured endpoint wins over the CLI's current context", () => {
    const e = resolveEndpointFrom(inputs({ configured: "ssh://deploy@box", current: "local" }));
    expect(e).toMatchObject({ kind: "ssh", destination: "deploy@box", source: "system.yaml" });
  });

  it("the current context is used when nothing explicit is set", () => {
    const e = resolveEndpointFrom(inputs({ current: "local" }));
    expect(e).toEqual({ kind: "unix", path: "/Users/me/.orbstack/run/docker.sock", source: "current context" });
  });

  it("no current context falls back to the default socket, as Docker itself would", () => {
    expect(resolveEndpointFrom(inputs())).toEqual({ kind: "unix", path: "/var/run/docker.sock", source: "default" });
  });

  it("a DOCKER_CONTEXT that does not exist is unsupported, not a silent fallback to the local daemon", () => {
    const e = resolveEndpointFrom(inputs({ env: { DOCKER_CONTEXT: "gone" }, current: "local" }));
    expect(e).toMatchObject({ kind: "unsupported", raw: "gone", source: "DOCKER_CONTEXT" });
  });

  it("a tcp context with TLS material keeps tls: true", () => {
    expect(resolveEndpointFrom(inputs({ env: { DOCKER_CONTEXT: "secured" } }))).toMatchObject({ kind: "tcp", host: "10.0.0.5", port: 2376, tls: true });
  });

  it("DOCKER_TLS_VERIFY marks a tcp DOCKER_HOST as TLS", () => {
    expect(resolveEndpointFrom(inputs({ env: { DOCKER_HOST: "tcp://h:2376", DOCKER_TLS_VERIFY: "1" } }))).toMatchObject({ kind: "tcp", tls: true });
  });
});

describe("resolveEndpointFrom: Podman keeps its pre-S50 rule", () => {
  it("a unix CONTAINER_HOST is used", () => {
    expect(resolveEndpointFrom(inputs({ runtime: "podman", env: { CONTAINER_HOST: "unix:///run/podman/podman.sock" } })))
      .toEqual({ kind: "unix", path: "/run/podman/podman.sock", source: "CONTAINER_HOST" });
  });

  it("any other CONTAINER_HOST is unsupported", () => {
    expect(resolveEndpointFrom(inputs({ runtime: "podman", env: { CONTAINER_HOST: "ssh://core@vm/run/podman/podman.sock" } })))
      .toMatchObject({ kind: "unsupported", source: "CONTAINER_HOST" });
  });

  it("DOCKER_HOST does not redirect podman, and the default is the rootless socket for a non-root user", () => {
    expect(resolveEndpointFrom(inputs({ runtime: "podman", env: { DOCKER_HOST: "ssh://x@y", XDG_RUNTIME_DIR: "/run/user/501" } })))
      .toEqual({ kind: "unix", path: "/run/user/501/podman/podman.sock", source: "default" });
  });
});

describe("parseHost", () => {
  it.each([
    ["unix://", "unix:// with no path"],
    ["ssh://", "ssh:// with no host"],
    ["not a host", "not a URL"],
    ["tcp://host", "tcp:// needs host and port"],
    ["npipe:////./pipe/docker_engine", "npipe:// is not supported"],
    ["fd://", "fd:// is not supported"],
  ])("%s is unsupported (%s)", (raw, reason) => {
    expect(parseHost(raw, "DOCKER_HOST")).toMatchObject({ kind: "unsupported", reason });
  });

  it("an ssh host without a user or port keeps both absent", () => {
    expect(parseHost("ssh://server", "DOCKER_HOST")).toEqual({ kind: "ssh", url: "ssh://server", destination: "server", source: "DOCKER_HOST" });
  });
});

describe("endpointEnv: a child reaches the same daemon", () => {
  it("sets DOCKER_HOST and drops DOCKER_CONTEXT for every supported docker endpoint", () => {
    expect(endpointEnv(parseHost("ssh://ops@server", "DOCKER_CONTEXT"), "docker")).toEqual({ set: { DOCKER_HOST: "ssh://ops@server" }, unset: ["DOCKER_CONTEXT"] });
    expect(endpointEnv({ kind: "unix", path: "/s.sock", source: "default" }, "docker")).toEqual({ set: { DOCKER_HOST: "unix:///s.sock" }, unset: ["DOCKER_CONTEXT"] });
    expect(endpointEnv(parseHost("tcp://h:2375", "DOCKER_HOST"), "docker").set).toEqual({ DOCKER_HOST: "tcp://h:2375" });
  });

  it("changes nothing for podman or an unsupported endpoint", () => {
    expect(endpointEnv({ kind: "unix", path: "/p.sock", source: "default" }, "podman")).toEqual({ set: {}, unset: [] });
    expect(endpointEnv(parseHost("npipe:////./pipe/x", "DOCKER_HOST"), "docker")).toEqual({ set: {}, unset: [] });
  });
});

describe("describeEndpoint", () => {
  it("names the source", () => {
    expect(describeEndpoint(parseHost("ssh://ops@server", "DOCKER_CONTEXT"))).toBe("ssh://ops@server (from DOCKER_CONTEXT)");
  });
});
