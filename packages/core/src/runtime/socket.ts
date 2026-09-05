/**
 * Where the runtime's API socket is. Observation goes over it; the CLI binary is for
 * mutation only (docs/steering/structure.md). One resolver, in core; the server command
 * used to carry it.
 *
 * Order: `APPBAY_RUNTIME_SOCKET`; docker's `unix://` `DOCKER_HOST` or podman's `unix://`
 * `CONTAINER_HOST`; then the runtime's default — Docker's `/var/run/docker.sock`, Podman's rootful socket for uid 0 and
 * the rootless one under `XDG_RUNTIME_DIR` otherwise. A tcp:// or ssh:// host names no local
 * path, so it falls through to the default rather than to a guess.
 */
import { existsSync } from "node:fs";
import { resolveContainerRuntime } from "./container-runtime.js";

export function runtimeSocketFor(
  runtime: string,
  uid: number,
  xdgRuntimeDir?: string,
  override?: string,
  containerHost?: string,
): string {
  if (override) return override;
  // CONTAINER_HOST is podman's variable; a docker install ignores it (a stray podman path must
  // not redirect docker). Docker's own DOCKER_HOST is folded into `override` by the resolver.
  if (runtime !== "podman") return "/var/run/docker.sock";
  if (containerHost?.startsWith("unix://")) return containerHost.slice("unix://".length);
  return uid === 0 ? "/run/podman/podman.sock" : `${xdgRuntimeDir ?? `/run/user/${uid}`}/podman/podman.sock`;
}

/** The socket this process observes the runtime through. */
export function resolveRuntimeSocket(appbayHome?: string): string {
  const runtime = resolveContainerRuntime(appbayHome);
  const dockerHost = process.env.DOCKER_HOST;
  const dockerOverride = runtime !== "podman" && dockerHost?.startsWith("unix://") ? dockerHost.slice("unix://".length) : undefined;
  return runtimeSocketFor(
    runtime,
    process.getuid?.() ?? 0,
    process.env.XDG_RUNTIME_DIR,
    process.env.APPBAY_RUNTIME_SOCKET ?? dockerOverride,
    process.env.CONTAINER_HOST,
  );
}

/** Whether the resolved socket exists on this host; the reason names it when not. */
export function socketAvailable(appbayHome?: string): { path: string; ok: boolean; reason?: string } {
  const path = resolveRuntimeSocket(appbayHome);
  if (existsSync(path)) return { path, ok: true };
  return {
    path,
    ok: false,
    reason: `no runtime API socket at ${path} — enable the runtime's socket (podman: \`systemctl --user enable --now podman.socket\`, or rootful \`podman.socket\`) or set APPBAY_RUNTIME_SOCKET`,
  };
}
