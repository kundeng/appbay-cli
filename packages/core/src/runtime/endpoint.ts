/**
 * The one daemon a command deploys to and observes (S50).
 *
 * A system is the runtime endpoint it targets, wherever appbay runs. Mutation goes through
 * the container binary and observation through the Engine API; both take this module's
 * answer, so they cannot reach two different daemons. Before S50 the binary followed
 * `DOCKER_CONTEXT` or an `ssh://` `DOCKER_HOST` while observation read the local default
 * socket (#16).
 *
 * Order, Docker's own with the configured value inserted where an explicit choice sits:
 * `APPBAY_RUNTIME_SOCKET`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `endpoint` in `etc/system.yaml`,
 * the Docker CLI's current context, then the runtime's default socket. Docker CLI 29 was
 * measured to rank `DOCKER_HOST` above `DOCKER_CONTEXT` (S50, "Verified before writing").
 *
 * Podman keeps its pre-S50 rule: a `unix://` `CONTAINER_HOST`, else its default socket. Any
 * other Podman remote is unsupported, and observation over it is unknown.
 */
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { runtimeSocketFor } from "./socket.js";
import type { ContainerRuntime } from "../schemas/instance.js";

export type EndpointSource =
  | "APPBAY_RUNTIME_SOCKET"
  | "DOCKER_HOST"
  | "DOCKER_CONTEXT"
  | "system.yaml"
  | "current context"
  | "CONTAINER_HOST"
  | "default";

export type Endpoint =
  | { kind: "unix"; path: string; source: EndpointSource }
  /** `url` is the `ssh://` form exactly as given; `destination` is what `ssh` takes. */
  | { kind: "ssh"; url: string; destination: string; port?: number; source: EndpointSource }
  | { kind: "tcp"; host: string; port: number; tls: boolean; source: EndpointSource }
  | { kind: "unsupported"; raw: string; reason: string; source: EndpointSource };

/** What a context reader answers: the context's docker host, or why it could not say. */
export type ContextHost = { ok: true; host: string; tls: boolean } | { ok: false; reason: string };

export interface EndpointInputs {
  runtime: ContainerRuntime;
  env: Readonly<Record<string, string | undefined>>;
  /** `endpoint` from `etc/system.yaml`, when the installation records one. */
  configured?: string;
  /** Reads a named context's host; `undefined` names the CLI's current context. */
  readContext: (name: string | undefined) => ContextHost;
  uid: number;
}

/** Parse a docker host URL. TLS for `tcp` comes from the caller, which knows its source. */
export function parseHost(raw: string, source: EndpointSource, tls = false): Endpoint {
  const value = raw.trim();
  if (value.startsWith("unix://")) {
    const path = value.slice("unix://".length);
    return path ? { kind: "unix", path, source } : { kind: "unsupported", raw: value, reason: "unix:// with no path", source };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "unsupported", raw: value, reason: "not a URL", source };
  }
  if (url.protocol === "ssh:") {
    if (!url.hostname) return { kind: "unsupported", raw: value, reason: "ssh:// with no host", source };
    const user = url.username ? `${decodeURIComponent(url.username)}@` : "";
    const port = url.port ? Number(url.port) : undefined;
    return { kind: "ssh", url: value, destination: `${user}${url.hostname}`, ...(port ? { port } : {}), source };
  }
  if (url.protocol === "tcp:") {
    if (!url.hostname || !url.port) return { kind: "unsupported", raw: value, reason: "tcp:// needs host and port", source };
    return { kind: "tcp", host: url.hostname, port: Number(url.port), tls, source };
  }
  return { kind: "unsupported", raw: value, reason: `${url.protocol}// is not supported`, source };
}

/** The pure resolution: every input passed in, so each precedence case is testable. */
export function resolveEndpointFrom(inputs: EndpointInputs): Endpoint {
  const { runtime, env } = inputs;
  const override = env.APPBAY_RUNTIME_SOCKET;
  if (override) return { kind: "unix", path: override, source: "APPBAY_RUNTIME_SOCKET" };

  if (runtime === "podman") {
    const containerHost = env.CONTAINER_HOST;
    if (containerHost?.startsWith("unix://")) return parseHost(containerHost, "CONTAINER_HOST");
    if (containerHost) return { kind: "unsupported", raw: containerHost, reason: "a Podman remote other than unix:// is not supported", source: "CONTAINER_HOST" };
    return { kind: "unix", path: runtimeSocketFor("podman", inputs.uid, env.XDG_RUNTIME_DIR), source: "default" };
  }

  if (env.DOCKER_HOST) {
    // The Docker CLI turns on TLS for tcp:// when DOCKER_TLS_VERIFY is set or certificates are named.
    const tls = Boolean(env.DOCKER_TLS_VERIFY) || Boolean(env.DOCKER_CERT_PATH);
    return parseHost(env.DOCKER_HOST, "DOCKER_HOST", tls);
  }
  if (env.DOCKER_CONTEXT) return fromContext(inputs.readContext(env.DOCKER_CONTEXT), env.DOCKER_CONTEXT, "DOCKER_CONTEXT");
  if (inputs.configured) return parseHost(inputs.configured, "system.yaml");

  const current = inputs.readContext(undefined);
  // No CLI, or a CLI without contexts, is not an error here: the default socket is what Docker
  // itself would use.
  if (current.ok) return parseHost(current.host, "current context", current.tls);
  return { kind: "unix", path: runtimeSocketFor("docker", inputs.uid), source: "default" };
}

function fromContext(answer: ContextHost, name: string, source: EndpointSource): Endpoint {
  if (!answer.ok) return { kind: "unsupported", raw: name, reason: answer.reason, source };
  return parseHost(answer.host, source, answer.tls);
}

/** The part of `docker context inspect` this module reads. */
const ContextInspect = z.object({
  Endpoints: z.object({ docker: z.object({ Host: z.string().optional() }).optional() }),
  TLSMaterial: z.object({ docker: z.unknown().optional() }).nullable().optional(),
});

/** Ask the Docker CLI for a context's host. Runs with no DOCKER_HOST, which would mask contexts. */
export function readDockerContext(name: string | undefined): ContextHost {
  const env = { ...process.env };
  delete env.DOCKER_HOST;
  delete env.DOCKER_CONTEXT;
  const target = name ?? currentContextName(env);
  if (!target) return { ok: false, reason: "no current docker context" };
  const result = spawnSync("docker", ["context", "inspect", target, "--format", "{{json .}}"], { encoding: "utf-8", env, timeout: 5000 });
  if (result.error) return { ok: false, reason: `docker context inspect: ${result.error.message}` };
  if (result.status !== 0) return { ok: false, reason: (result.stderr || `docker context inspect ${target} exited ${String(result.status)}`).trim() };
  let json: unknown;
  try { json = JSON.parse(result.stdout); } catch { return { ok: false, reason: `context ${target}: inspect output is not JSON` }; }
  const parsed = ContextInspect.safeParse(json);
  if (!parsed.success) return { ok: false, reason: `context ${target}: unexpected inspect shape: ${parsed.error.issues[0]?.message ?? "?"}` };
  const host = parsed.data.Endpoints.docker?.Host;
  if (!host) return { ok: false, reason: `context ${target} names no docker host` };
  return { ok: true, host, tls: Boolean(parsed.data.TLSMaterial?.docker) };
}

function currentContextName(env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync("docker", ["context", "show"], { encoding: "utf-8", env, timeout: 5000 });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

/**
 * The environment a container-binary child needs to reach `endpoint`: the endpoint as
 * `DOCKER_HOST`, and no `DOCKER_CONTEXT` to override it. Podman and unsupported endpoints
 * change nothing, so their children behave as before S50.
 */
export function endpointEnv(endpoint: Endpoint, runtime: ContainerRuntime): { set: Record<string, string>; unset: string[] } {
  if (runtime === "podman") return { set: {}, unset: [] };
  switch (endpoint.kind) {
    case "unix": return { set: { DOCKER_HOST: `unix://${endpoint.path}` }, unset: ["DOCKER_CONTEXT"] };
    case "ssh": return { set: { DOCKER_HOST: endpoint.url }, unset: ["DOCKER_CONTEXT"] };
    case "tcp": return { set: { DOCKER_HOST: `tcp://${endpoint.host}:${String(endpoint.port)}` }, unset: ["DOCKER_CONTEXT"] };
    case "unsupported": return { set: {}, unset: [] };
  }
}

/** One line for `info` and `doctor`: where, and which source chose it. */
export function describeEndpoint(endpoint: Endpoint): string {
  switch (endpoint.kind) {
    case "unix": return `unix://${endpoint.path} (from ${endpoint.source})`;
    case "ssh": return `${endpoint.url} (from ${endpoint.source})`;
    case "tcp": return `tcp://${endpoint.host}:${String(endpoint.port)}${endpoint.tls ? " with TLS" : ""} (from ${endpoint.source})`;
    case "unsupported": return `${endpoint.raw}: ${endpoint.reason} (from ${endpoint.source})`;
  }
}
