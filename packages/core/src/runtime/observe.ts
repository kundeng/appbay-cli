/**
 * What the runtime reports about containers, as values, read over its API socket.
 *
 * Observation never parses CLI text: Docker Compose and podman-compose disagree on flags,
 * field names and banners, and every parser of theirs existed twice. The Engine API, which
 * Podman serves as its compat API, has one shape. Mutation (`compose up`, `down`) stays with
 * the compose binary, which owns project naming and recreate semantics.
 *
 * Every function answers with an `Inspection`: a value, or the reason the runtime could not
 * be asked. `unknown` is never a verdict, and there is no fallback to text parsing: a host
 * without a reachable socket reports exactly that.
 */

import type { Inspection } from "./container-runtime.js";
import { apiInspectContainer, apiListContainers, apiNetworkExists, type ContainerSummary, type EngineOptions } from "./engine-api.js";

/** Result of one compose invocation (mutation). */
export interface DockerComposeResult {
  exitCode: number;
  output: string;
}

/** Runs `compose -f <composePath> <subArgs>` with an optional child environment. */
export type DockerComposeRunner = (
  subArgs: string[],
  composePath: string,
  env?: Record<string, string>,
) => DockerComposeResult;

/** One container of a compose project. */
export interface ComposePsRow {
  name: string;
  id: string;
  service: string;
  /** Lower-cased state word: running, exited, created, restarting, … */
  state: string;
  /** The runtime's human status line, e.g. "Up 3 seconds (healthy)". */
  status: string;
  /** Published ports, rendered `host->container/proto`, comma-joined. */
  ports: string;
  /** `healthy`, `unhealthy`, `starting`, or "" when the service declares no healthcheck. */
  health: string;
  exitCode: number;
}

/** One container matched by label. */
export interface ContainerMatch {
  name: string;
  /** The runtime's own state word, lower-cased. */
  state: string;
  running: boolean;
}

/**
 * The questions a deploy asks about the world. The default implementation is the API over
 * the socket; a test hands in rows directly. This is the seam stackbay's `Runtime.Inspect`
 * names (lessons L5, L10).
 */
export interface Observer {
  /** The containers of one compose project (the app directory's name). */
  project(project: string): Promise<Inspection<ComposePsRow[]>>;
  /** The container carrying `label=value` (and every extra label); running preferred; two running is unknown. */
  findByLabel(label: string, value: string, labels?: Record<string, string>): Promise<Inspection<ContainerMatch | null>>;
  networkExists(name: string): Promise<Inspection<boolean>>;
}

const COMPOSE_PROJECT = "com.docker.compose.project";
const COMPOSE_SERVICE = "com.docker.compose.service";

/** Ports as `host->container/proto`, comma-joined, from the API's port list. */
export function formatPorts(ports: ContainerSummary["Ports"]): string {
  return (ports ?? [])
    .map((p) => (p.PublicPort ? `${String(p.PublicPort)}->${String(p.PrivatePort)}/${p.Type}` : `${String(p.PrivatePort)}/${p.Type}`))
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");
}

/** The health word inside a status line, e.g. "Up 3 seconds (healthy)" → "healthy". */
function healthFromStatus(status: string): string {
  const m = /\((healthy|unhealthy|health: starting)\)/.exec(status);
  return m ? m[1]!.replace("health: ", "") : "";
}

async function rowsFrom(summaries: ContainerSummary[], options: EngineOptions): Promise<Inspection<ComposePsRow[]>> {
  const rows: ComposePsRow[] = [];
  for (const c of summaries) {
    const name = (c.Names[0] ?? "").replace(/^\//, "");
    const state = c.State.toLowerCase();
    let exitCode = 0;
    if (state === "exited") {
      // The list does not carry the exit code; only an exited container is worth the extra ask.
      const detail = await apiInspectContainer(c.Id, options);
      if (detail.kind === "unknown") return detail;
      exitCode = detail.value?.State.ExitCode ?? 0;
    }
    rows.push({
      name,
      id: c.Id,
      service: c.Labels?.[COMPOSE_SERVICE] ?? name,
      state,
      status: c.Status,
      ports: formatPorts(c.Ports),
      health: healthFromStatus(c.Status),
      exitCode,
    });
  }
  return { kind: "ok", value: rows };
}

/** The API-backed observer for one install. */
export function engineObserver(appbayHome?: string, socketPath?: string): Observer {
  const options: EngineOptions = { appbayHome, socketPath };
  return {
    async project(project) {
      const list = await apiListContainers({ labels: { [COMPOSE_PROJECT]: project } }, options);
      if (list.kind === "unknown") return list;
      return rowsFrom(list.value, options);
    },
    async findByLabel(label, value, labels = {}) {
      const list = await apiListContainers({ labels: { [label]: value, ...labels } }, options);
      if (list.kind === "unknown") return list;
      const matches: ContainerMatch[] = list.value.map((c) => {
        const state = c.State.toLowerCase();
        return { name: (c.Names[0] ?? "").replace(/^\//, ""), state, running: state === "running" };
      });
      if (matches.length === 0) return { kind: "ok", value: null };
      const running = matches.filter((m) => m.running);
      if (running.length > 1) {
        return { kind: "unknown", reason: `${String(running.length)} running containers carry ${label}=${value}: ${running.map((m) => m.name).join(", ")}` };
      }
      return { kind: "ok", value: running[0] ?? matches[0]! };
    },
    networkExists(name) {
      return apiNetworkExists(name, options);
    },
  };
}

/** Module-level convenience over `engineObserver`, for callers with a home and no observer in hand. */
export function findContainerByLabel(
  label: string,
  value: string,
  options: { appbayHome?: string; labels?: Record<string, string>; observer?: Observer } = {},
): Promise<Inspection<ContainerMatch | null>> {
  return (options.observer ?? engineObserver(options.appbayHome)).findByLabel(label, value, options.labels);
}

/** Whether a container exists and is running. */
export async function isRunning(container: string, appbayHome?: string): Promise<Inspection<boolean>> {
  const r = await apiInspectContainer(container, { appbayHome });
  if (r.kind === "unknown") return r;
  return { kind: "ok", value: r.value?.State.Running === true };
}

/** Whether a network exists. */
export function networkExists(network: string, appbayHome?: string): Promise<Inspection<boolean>> {
  return apiNetworkExists(network, { appbayHome });
}

/** Names of running containers whose name contains `namePart`. */
export async function runningContainerNames(namePart: string, appbayHome?: string): Promise<Inspection<string[]>> {
  const list = await apiListContainers({ name: namePart }, { appbayHome });
  if (list.kind === "unknown") return list;
  return { kind: "ok", value: list.value.filter((c) => c.State.toLowerCase() === "running").map((c) => (c.Names[0] ?? "").replace(/^\//, "")) };
}

/**
 * Services that exited non-zero, or are restart-looping (a `restart:` policy keeps a crashed
 * service in state `restarting`, which is a crash wearing a different word). `up -d`
 * exiting 0 means started, not still running; a zero exit is a completed one-shot, not a
 * crash. `ok([])` is "nothing crashed".
 */
export async function findCrashedServices(observer: Observer, project: string): Promise<Inspection<string[]>> {
  const rows = await observer.project(project);
  if (rows.kind === "unknown") return rows;
  const dead: string[] = [];
  for (const r of rows.value) {
    if (r.state === "exited" && r.exitCode !== 0) dead.push(`${r.service} exited ${String(r.exitCode)}`);
    else if (r.state === "restarting") dead.push(`${r.service} is restart-looping`);
  }
  return { kind: "ok", value: dead };
}

/** One container's identity and run state. */
export interface ContainerState {
  id: string;
  running: boolean;
}

/** The project's containers keyed by name, stopped ones included. */
export async function snapshotContainers(observer: Observer, project: string): Promise<Inspection<Map<string, ContainerState>>> {
  const rows = await observer.project(project);
  if (rows.kind === "unknown") return rows;
  const snapshot = new Map<string, ContainerState>();
  for (const r of rows.value) snapshot.set(r.name, { id: r.id, running: r.state === "running" });
  return { kind: "ok", value: snapshot };
}

/**
 * Did `up -d` change the running world? True when a container was created, recreated
 * (same name, new id) or started; false only for "already running". An unchanged
 * rendered file says nothing about this, which is why it is asked separately.
 */
export function didConverge(
  before: Inspection<Map<string, ContainerState>>,
  after: Inspection<Map<string, ContainerState>>,
): Inspection<boolean> {
  if (before.kind === "unknown") return before;
  if (after.kind === "unknown") return after;
  for (const [name, now] of after.value) {
    const was = before.value.get(name);
    if (!was) return { kind: "ok", value: true };
    if (was.id !== now.id) return { kind: "ok", value: true };
    if (!was.running && now.running) return { kind: "ok", value: true };
  }
  return { kind: "ok", value: false };
}

/**
 * Is a project ready: every container running, and every one with a healthcheck healthy.
 * A service with no healthcheck is ready when it runs; the operator docs say so.
 */
export async function isReady(observer: Observer, project: string): Promise<Inspection<{ ready: boolean; detail: string }>> {
  const rows = await observer.project(project);
  if (rows.kind === "unknown") return rows;
  if (rows.value.length === 0) return { kind: "ok", value: { ready: false, detail: "no containers yet" } };
  // A one-shot service (a hooks init container, `restart: no`) that exited 0 is done, not
  // pending; findCrashedServices already reads exit 0 the same way (review 2026-09-06, F4).
  const done = (r: ComposePsRow) => r.state === "exited" && r.exitCode === 0;
  const waiting = rows.value
    .filter((r) => !done(r) && (r.state !== "running" || (r.health !== "" && r.health !== "healthy")))
    .map((r) => `${r.service} is ${r.state}${r.health ? ` (${r.health})` : ""}`);
  return { kind: "ok", value: { ready: waiting.length === 0, detail: waiting.join(", ") } };
}

/**
 * Where a container's port answers from this host: the published host port when there is
 * one, else the container's address on any of its networks. Null when neither exists.
 */
export async function containerEndpoint(container: string, port: number, appbayHome?: string): Promise<Inspection<string | null>> {
  const { apiInspectContainer } = await import("./engine-api.js");
  const r = await apiInspectContainer(container, { appbayHome });
  if (r.kind === "unknown") return r;
  const net = r.value?.NetworkSettings;
  const published = net?.Ports?.[`${String(port)}/tcp`]?.[0]?.HostPort;
  if (published) return { kind: "ok", value: `localhost:${published}` };
  const ip = Object.values(net?.Networks ?? {}).map((n) => n.IPAddress).find((a) => a);
  return { kind: "ok", value: ip ? `${ip}:${String(port)}` : null };
}
