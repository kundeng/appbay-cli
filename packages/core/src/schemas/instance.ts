/**
 * Zod schema for the instance-level config at `$APPBAY_HOME/project.yaml`.
 *
 * ⚠️ THIS IS NOT `ProjectConfigSchema`. Two different files share the name
 * `project.yaml` and they are not interchangeable:
 *
 *   $APPBAY_HOME/project.yaml                     <- THIS file. One per appbay
 *                                                    installation. Written by
 *                                                    `appbay init`. Keys:
 *                                                    project, domain,
 *                                                    catalog_source,
 *                                                    container_runtime.
 *   $APPBAY_HOME/etc/projects/<name>/project.yaml <- ProjectConfigSchema in
 *                                                    ./project.ts. Per project,
 *                                                    scope resolution. Keys:
 *                                                    name, vars, defaults.
 *
 * Until this schema existed the instance file had no typed boundary at all: it
 * was written as hand-built text by `writeProjectConfig` and read back by REGEX
 * in at least three places (`init.ts` readProjectConfig, `deploy-service.ts`
 * loadProjectVars). A regex reader cannot tell a missing key from a malformed
 * one, silently yields undefined for both, and every caller then invents its own
 * fallback. Parsing through this schema makes the failure explicit and the
 * defaults single-sourced.
 */

import { z } from "zod";
import { parse as parseYaml } from "yaml";

/**
 * Container runtime that drives compose and container commands.
 *
 * ⚠️ This selects the CLIENT BINARY, not the daemon. `docker` here can perfectly
 * well be talking to a rootful `podman.socket` via `DOCKER_HOST` — that is the
 * documented and preferred podman arrangement, since podman's own man page notes
 * `docker-compose` takes precedence as a compose provider when installed. Choose
 * `podman` only when you want the `podman` binary itself invoked.
 */
export const ContainerRuntimeSchema = z.enum(["docker", "podman"]);
export type ContainerRuntime = z.infer<typeof ContainerRuntimeSchema>;

/** Default runtime when nothing is configured — preserves prior behaviour. */
export const DEFAULT_CONTAINER_RUNTIME: ContainerRuntime = "docker";

/**
 * Reverse proxy that fronts every app on this installation.
 *
 * 🚨 INSTALLATION-LEVEL, NOT PER-APP, and that is a correctness constraint rather than a
 * convenience. Every app on a host is routed by the same proxy. If this were a trait
 * property two apps could disagree about which proxy is deployed, and the loser would
 * emit a perfectly valid config file for a proxy that is not running — no error, no
 * route, nothing to grep for.
 */
export const IngressProviderSchema = z.enum(["traefik", "caddy"]);

/**
 * DNS providers appbay can drive for the ACME DNS-01 challenge.
 *
 * ⚠️ One entry today, and the enum exists anyway: adding a provider is not just a string,
 * it is a Caddy module that has to be compiled into the image (`xcaddy --with
 * github.com/caddy-dns/<p>`). A free-form string would let an operator name a provider
 * appbay cannot build, and the failure would land at certificate issuance rather than at
 * configuration.
 */
export const AcmeDnsProviderSchema = z.enum(["cloudflare"]);
export type AcmeDnsProvider = z.infer<typeof AcmeDnsProviderSchema>;
export type IngressProvider = z.infer<typeof IngressProviderSchema>;

/** Default ingress provider when nothing is configured — preserves prior behaviour. */
export const DEFAULT_INGRESS_PROVIDER: IngressProvider = "traefik";

export const InstanceConfigSchema = z.object({
  /** Project name — the compose project prefix and ingress label root. */
  project: z.string().optional(),

  /** Base domain for ingress routing (exposed to compiles as DOMAIN). */
  domain: z.string().optional(),

  /** Catalog source: a local path or a git URL. Absent means the default. */
  catalog_source: z.string().optional(),

  /**
   * Container runtime binary for this installation.
   *
   * Absent is meaningful and is NOT the same as "docker": it means the
   * installation predates this key, so callers fall back to
   * DEFAULT_CONTAINER_RUNTIME. Kept optional so an existing project.yaml keeps
   * parsing rather than failing closed on upgrade.
   */
  container_runtime: ContainerRuntimeSchema.optional(),

  /**
   * The container STORE this installation is bound to — the directory holding the
   * images, volumes and networks it created (#58 R3).
   *
   * 🚨 WHY A SECOND KEY, when `container_runtime` already says "podman". Because
   * "podman" is not one store. Rootful and rootless podman keep entirely separate
   * ones:
   *
   *   rootful   /var/lib/containers/storage
   *   rootless  /home/<user>/.local/share/containers/storage
   *
   * `appbay init` as an ordinary user on a host with an active rootful socket bound
   * to the rootless store without saying so, put `appbay_shared` there, and the
   * operator met `External network [appbay_shared] does not exists` on a later
   * `sudo appbay up`. The runtime matched; the store did not. Recording the store is
   * what makes that detectable — and detectable LATER, which a check performed only
   * at init can never be, because init is not when the switch happens.
   *
   * Absent is meaningful: the installation predates this key. Callers must treat it
   * as "unknown, do not block" rather than as a mismatch, or every existing install
   * fails closed on upgrade for a question it was never asked.
   */
  container_store: z.string().optional(),

  /**
   * Reverse proxy for this installation. Absent means the installation predates this
   * key, so callers fall back to DEFAULT_INGRESS_PROVIDER — which is not the same
   * statement as "traefik was chosen".
   */
  ingress_provider: IngressProviderSchema.optional(),

  /**
   * SELinux confinement for the CONTROL-PLANE CONTAINER only.
   *
   * 🚨 WHY THIS EXISTS. On a SELinux Enforcing host the control-plane container cannot reach
   * the container runtime's socket, even as root, even with the socket relabelled
   * `container_file_t` via `:z`. Measured on Fedora 43 + rootful podman 5.6.2:
   *
   *   Enforcing, socket var_run_t        → permission denied
   *   Enforcing, socket container_file_t → permission denied   ← a relabel is NOT enough
   *   Permissive                         → works (podman 5.6.2)
   *
   * The denial is the `unix_stream_socket connectto` check against the API service's process
   * label, which no file relabel can satisfy. So a host in this configuration can start the
   * control plane and serve the UI, but every deploy from the web fails.
   *
   * ⚠️ `unconfined` DISABLES SELinux confinement for the most privileged container in the
   * system. That is a real reduction in security posture, it is why `confined` is the
   * default, and it is why this is an explicit setting rather than something Appbay decides
   * for an operator. The durable alternative is a policy module granting just `connectto`,
   * which keeps confinement; that is tracked separately (issue #58).
   *
   * Absent means `confined` — an installation that predates this key has not opted out.
   */
  control_plane_selinux: z.enum(["confined", "unconfined"]).optional(),

  /**
   * DNS provider for the ACME DNS-01 challenge, if this installation uses one.
   *
   * 🚨 ABSENT MEANS "NO DNS-01", and that is a real choice rather than a missing value:
   * Caddy then uses HTTP-01 for public names and its INTERNAL issuer for anything that is
   * not publicly resolvable. The internal issuer succeeds silently, which is why an
   * install can look healthy for weeks and have never spoken to a real CA.
   *
   * Setting it is what makes appbay responsible for the whole certificate path — writing
   * the per-site `tls` snippet, and building a Caddy image that actually carries the
   * provider module. Neither happens without it.
   */
  acme_dns_provider: AcmeDnsProviderSchema.optional(),
});

export type InstanceConfig = z.infer<typeof InstanceConfigSchema>;

/**
 * Parse instance config from raw YAML text.
 *
 * Returns `{}` for empty or unparseable input rather than throwing — a missing
 * or corrupt project.yaml must not take down commands that do not need it
 * (`appbay --help` should not require a valid install). Callers needing the
 * strict result should use `InstanceConfigSchema.parse` directly.
 *
 * ⚠️ Unknown keys are DROPPED, not rejected. A newer appbay writing a key this
 * version does not know must not break this version.
 */
export function parseInstanceConfig(text: string): InstanceConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== "object") return {};
  const result = InstanceConfigSchema.safeParse(raw);
  return result.success ? result.data : {};
}
