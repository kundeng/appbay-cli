/**
 * What compose reports about a project's containers, on either provider, as values.
 *
 * Every function here answers a question about the runtime with an `Inspection`: a value,
 * or the reason none could be obtained. None of them decides what a deploy should do with
 * the answer; that is the caller's job. This is the one place `compose ps` output is parsed.
 */

import type { Inspection } from "./container-runtime.js";

/** Result of one compose invocation. */
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

/** One container row, normalised across Docker Compose and podman-compose. */
export interface ComposePsRow {
  name: string;
  id: string;
  service: string;
  /** Lower-cased state word: running, exited, created, restarting, … */
  state: string;
  /** The provider's human status line, e.g. "Up 3 seconds". */
  status: string;
  /** Published ports, rendered `host->container/proto`, comma-joined. */
  ports: string;
  exitCode: number;
}

/**
 * List a project's containers. `all` includes stopped ones, which the crash check and the
 * converge snapshot both need. Docker needs `-a` for that; podman-compose rejects `-a` and
 * lists stopped containers anyway, so the plain form is the fallback.
 */
export function composePs(
  run: DockerComposeRunner,
  composePath: string,
  env: Record<string, string>,
  options: { all?: boolean } = { all: true },
): Inspection<ComposePsRow[]> {
  let ps = options.all !== false
    ? run(["ps", "-a", "--format", "json"], composePath, env)
    : run(["ps", "--format", "json"], composePath, env);
  if (ps.exitCode !== 0 && options.all !== false) {
    ps = run(["ps", "--format", "json"], composePath, env);
  }
  if (ps.exitCode !== 0) {
    return { kind: "unknown", reason: ps.output.trim() || `compose ps exited with code ${String(ps.exitCode)}` };
  }

  const rows: ComposePsRow[] = [];
  for (const row of parseComposePsJson(ps.output)) {
    const r = row as {
      ID?: string; Id?: string;
      Name?: string; Names?: string[];
      Service?: string; State?: string; Status?: string; ExitCode?: number;
      Ports?: unknown; Publishers?: unknown;
      Labels?: Record<string, string>;
    };
    const name = r.Name ?? (Array.isArray(r.Names) ? r.Names[0] : undefined) ?? r.Service;
    if (!name) continue;
    rows.push({
      name,
      id: r.ID ?? r.Id ?? "",
      service: r.Service ?? r.Labels?.["com.docker.compose.service"] ?? name,
      state: (r.State ?? "").toLowerCase(),
      status: r.Status ?? "",
      ports: formatPorts(r.Publishers ?? r.Ports),
      exitCode: typeof r.ExitCode === "number" ? r.ExitCode : 0,
    });
  }
  return { kind: "ok", value: rows };
}

/**
 * Docker Compose emits NDJSON; podman-compose pretty-prints one array behind a provider
 * banner. Whole-document from the first structural character first, then line by line.
 */
export function parseComposePsJson(output: string): unknown[] {
  const start = output.search(/[[{]/);
  if (start >= 0) {
    try {
      const parsed: unknown = JSON.parse(output.slice(start));
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Not one document — fall through to NDJSON.
    }
  }
  const rows: unknown[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      for (const row of Array.isArray(parsed) ? parsed : [parsed]) rows.push(row);
    } catch {
      continue;
    }
  }
  return rows;
}

/** Ports as a string, from either a string or the `Publishers` array of objects. */
export function formatPorts(ports: unknown): string {
  if (typeof ports === "string") return ports;
  if (Array.isArray(ports)) {
    return ports
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const pub = p as Record<string, unknown>;
          const published = pub.PublishedPort ?? pub.published_port ?? "";
          const target = pub.TargetPort ?? pub.target_port ?? "";
          const protocol = pub.Protocol ?? pub.protocol ?? "tcp";
          if (published && Number(published) > 0) return `${published}->${target}/${protocol}`;
          return `${target}/${protocol}`;
        }
        return String(p);
      })
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

/**
 * Services that exited non-zero. `up -d` exiting 0 means started, not still running; a
 * zero exit is a completed one-shot, not a crash. `ok([])` is "nothing crashed".
 */
export function findCrashedServices(
  run: DockerComposeRunner,
  composePath: string,
  env: Record<string, string>,
): Inspection<string[]> {
  const rows = composePs(run, composePath, env);
  if (rows.kind === "unknown") return rows;
  const dead: string[] = [];
  for (const r of rows.value) {
    if (r.state === "exited" && r.exitCode !== 0) dead.push(`${r.service} exited ${String(r.exitCode)}`);
  }
  return { kind: "ok", value: dead };
}

/** One container's identity and run state. */
export interface ContainerState {
  id: string;
  running: boolean;
}

/** The project's containers keyed by name, stopped ones included. */
export function snapshotContainers(
  run: DockerComposeRunner,
  composePath: string,
  env: Record<string, string>,
): Inspection<Map<string, ContainerState>> {
  const rows = composePs(run, composePath, env);
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
