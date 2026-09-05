/**
 * The runtime's HTTP API over its unix socket: Docker's Engine API, which Podman serves as
 * its compat API. Typed answers, one shape on both runtimes, no text parsing. Every call
 * returns an `Inspection`: a value, or the reason the runtime could not be asked.
 */
import { request } from "node:http";
import { z } from "zod";
import type { Inspection } from "./container-runtime.js";
import { socketAvailable } from "./socket.js";

const TIMEOUT_MS = 5000;

export interface EngineOptions {
  /** Defaults to the resolved runtime socket. */
  socketPath?: string;
  appbayHome?: string;
}

interface Reply { status: number; body: string }

function get(path: string, socketPath: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET", timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("timeout", () => req.destroy(new Error(`no answer from ${socketPath} within ${String(TIMEOUT_MS)} ms`)));
    req.on("error", reject);
    req.end();
  });
}

async function engineGet<T>(path: string, schema: z.ZodType<T>, options: EngineOptions): Promise<Inspection<T | null>> {
  const socket = options.socketPath ? { path: options.socketPath, ok: true as const } : socketAvailable(options.appbayHome);
  if (!socket.ok) return { kind: "unknown", reason: socket.reason ?? `no socket at ${socket.path}` };
  let reply: Reply;
  try {
    reply = await get(path, socket.path);
  } catch (err) {
    return { kind: "unknown", reason: `${socket.path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (reply.status === 404) return { kind: "ok", value: null };
  if (reply.status < 200 || reply.status >= 300) {
    return { kind: "unknown", reason: `${path} answered ${String(reply.status)}: ${reply.body.trim().slice(0, 200)}` };
  }
  const parsed = schema.safeParse(JSON.parse(reply.body));
  if (!parsed.success) return { kind: "unknown", reason: `${path}: unexpected shape: ${parsed.error.issues[0]?.message ?? "?"}` };
  return { kind: "ok", value: parsed.data };
}

const ContainerSummary = z.object({
  Id: z.string(),
  Names: z.array(z.string()),
  Image: z.string().optional(),
  State: z.string(),
  Status: z.string(),
  Labels: z.record(z.string()).nullable().optional(),
  Ports: z.array(z.object({ IP: z.string().optional(), PrivatePort: z.number(), PublicPort: z.number().optional(), Type: z.string() })).optional(),
});
export type ContainerSummary = z.infer<typeof ContainerSummary>;

const ContainerDetail = z.object({
  Id: z.string(),
  Name: z.string(),
  Image: z.string(),
  State: z.object({
    Running: z.boolean(),
    Status: z.string(),
    ExitCode: z.number().optional(),
    StartedAt: z.string().optional(),
    Health: z.object({ Status: z.string() }).optional(),
  }),
  Config: z.object({ Image: z.string().optional() }).optional(),
});
export type ContainerDetail = z.infer<typeof ContainerDetail>;

/** `GET /_ping`: the runtime answers "OK" as text, not JSON. */
export async function apiPing(options: EngineOptions = {}): Promise<Inspection<true>> {
  const socket = options.socketPath ? { path: options.socketPath, ok: true as const } : socketAvailable(options.appbayHome);
  if (!socket.ok) return { kind: "unknown", reason: socket.reason ?? `no socket at ${socket.path}` };
  try {
    const reply = await get("/_ping", socket.path);
    return reply.status === 200 ? { kind: "ok", value: true } : { kind: "unknown", reason: `/_ping answered ${String(reply.status)}` };
  } catch (err) {
    return { kind: "unknown", reason: `${socket.path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** `GET /containers/json`, all containers, filtered by labels (AND). */
export async function apiListContainers(
  filters: { labels?: Record<string, string>; name?: string } = {},
  options: EngineOptions = {},
): Promise<Inspection<ContainerSummary[]>> {
  const f: Record<string, string[]> = {};
  if (filters.labels) f.label = Object.entries(filters.labels).map(([k, v]) => `${k}=${v}`);
  if (filters.name) f.name = [filters.name];
  const q = Object.keys(f).length ? `&filters=${encodeURIComponent(JSON.stringify(f))}` : "";
  const r = await engineGet(`/containers/json?all=1${q}`, z.array(ContainerSummary), options);
  if (r.kind === "unknown") return r;
  return { kind: "ok", value: r.value ?? [] };
}

/** `GET /containers/{id}/json`; null when the container does not exist. */
export async function apiInspectContainer(idOrName: string, options: EngineOptions = {}): Promise<Inspection<ContainerDetail | null>> {
  return engineGet(`/containers/${encodeURIComponent(idOrName)}/json`, ContainerDetail, options);
}

/** `GET /networks/{name}`: true, false, or unknown. */
export async function apiNetworkExists(name: string, options: EngineOptions = {}): Promise<Inspection<boolean>> {
  const r = await engineGet(`/networks/${encodeURIComponent(name)}`, z.object({ Name: z.string() }), options);
  if (r.kind === "unknown") return r;
  return { kind: "ok", value: r.value !== null };
}

/** `GET /images/{name}/json`: the image id, null when absent. */
export async function apiImageId(name: string, options: EngineOptions = {}): Promise<Inspection<string | null>> {
  const r = await engineGet(`/images/${encodeURIComponent(name)}/json`, z.object({ Id: z.string() }), options);
  if (r.kind === "unknown") return r;
  return { kind: "ok", value: r.value?.Id ?? null };
}
