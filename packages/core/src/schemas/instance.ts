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
import { EdgeIdentityConfigSchema } from "./edge-identity-providers.js";

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
  /**
   * The absolute path this tree believes it lives at — RFC-001 §2.4.
   *
   * 🚨 SELF-DECLARATION, NOT DISCOVERY. Discovery answers "where is the tree" and must live
   * OUTSIDE it (`$APPBAY_HOME`, `~/.config/appbay/home`). This answers "where does this tree
   * think it is", is read after the tree is found, and exists to detect a MOVED OR COPIED
   * home. It must be absolute: a relative path is true by construction and detects nothing.
   *
   * Nothing detected that before. `looksScaffolded()` is `existsSync(path/etc)` and that was
   * the whole check, so a home copied to another machine kept working against whatever the
   * copy contained — the same failure class the runtime socket gid is overridable for
   * ("copying an APPBAY_HOME to another machine must not silently keep the old one").
   *
   * ⚠️ Provisional placement. RFC-001 §2.1 merges this file into `etc/system.yaml`; the field
   * moves with it. It is here rather than in a new half-populated file because two config
   * files mid-migration is the confusion §2 exists to end.
   */
  home: z.string().optional(),
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
   * for an operator.
   *
   * 🚦 THE SUPPORTED POSTURE IS A PERMISSIVE HOST. Owner decision, 2026-08-21: SELinux
   * Permissive/Disabled is a documented PREREQUISITE on RHEL-family hosts (see
   * docs/guide/quickstart.qmd). A policy module granting just `connectto` would keep
   * confinement and was considered — it is NOT planned, because it means shipping and
   * versioning a compiled policy per distribution for this one socket. This key remains as
   * a per-container escape hatch for operators who cannot change the host mode.
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

  /**
   * Which identity providers the edge authenticates against — RFC-001 §1 (task 5.1b).
   *
   * 🚨 ABSENT IS NOT "no identity". It means the single local store, which is what every
   * installation has had since before this key existed. The edge renders the same block for
   * absent and for an explicit single-local config — byte for byte, asserted in
   * `edge-portal-config.test.ts` — so adding this key changes nothing until an operator puts
   * a provider in it.
   *
   * Setting an `ldap` or `oidc` provider is what makes the human-password count reach zero:
   * what remains is one `bindPasswordRef` / `clientSecretRef`, a `vault://` secret routed
   * through the ordinary path with no second mechanism.
   */
  edge_identity: EdgeIdentityConfigSchema.optional(),

  /**
   * Hostname the control plane is served at through the edge — RFC-001 §1 (task 5.1c).
   *
   * Absent derives `appbay.<domain>`. With no `domain:` either, there is no name to serve it
   * at and no edge route is written — which is the normal state for a local install and not
   * an error. The published port stays the way in until RFC-001 §1's cutover closes it.
   */
  server_host: z.string().optional(),
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

/** A recorded home that disagrees with where the tree was actually found. */
export interface HomeMismatch {
  /** The absolute path recorded inside the tree. */
  recorded: string;
  /** The path this invocation resolved to. */
  resolved: string;
}

/**
 * Compare a tree's self-declared home against where it was found — RFC-001 §2.4.
 *
 * Returns null when they agree, when nothing is recorded (a pre-§2.4 install), or when the
 * config cannot be read — absence is not disagreement, and a tree that has never recorded a
 * home must keep working.
 */
export function checkHomeAssertion(
  resolvedHome: string,
  configText: string | null,
): HomeMismatch | null {
  if (!configText) return null;
  let recorded: string | undefined;
  try {
    recorded = parseInstanceConfig(configText).home;
  } catch {
    return null;
  }
  if (!recorded) return null;
  // Compare with trailing separators normalised; /home/x and /home/x/ are the same tree.
  const norm = (p: string) => p.replace(/\/+$/, "");
  return norm(recorded) === norm(resolvedHome) ? null : { recorded, resolved: resolvedHome };
}

// ---------------------------------------------------------------------------
// Config file location — RFC-001 §2.1
// ---------------------------------------------------------------------------

/** Where the instance config lives from RFC-001 §2 onward, relative to APPBAY_HOME. */
export const SYSTEM_CONFIG_REL = "etc/system.yaml";

/** Pre-§2 location, read for one release so an existing install survives the upgrade. */
export const LEGACY_INSTANCE_CONFIG_REL = "project.yaml";

/**
 * Read the instance config, preferring `etc/system.yaml` and falling back to `project.yaml`.
 *
 * 🚨 THE FILENAME COLLISION IS THE POINT. `$APPBAY_HOME/project.yaml` and
 * `etc/projects/<name>/project.yaml` are two different files with two different schemas and
 * the same name — `instance.ts` carries a warning block about it — and the root one holds
 * `domain`, `container_runtime`, `ingress_provider` and friends, none of which is
 * project-scoped. Moving it to `etc/system.yaml` ends the collision and says what the file
 * actually is.
 *
 * ⚠️ The fallback is a MIGRATION SHIM, due out one release later, exactly like the legacy
 * password paths in `secrets/master-password.ts`. An install that has not been re-inited
 * keeps working; `appbay init` writes the new location and removes the old one.
 *
 * @returns the file's text, or null when neither exists.
 */
export function readInstanceConfigText(
  appbayHome: string,
  readFile: (path: string) => string,
): string | null {
  for (const rel of [SYSTEM_CONFIG_REL, LEGACY_INSTANCE_CONFIG_REL]) {
    try {
      return readFile(`${appbayHome}/${rel}`);
    } catch {
      // Try the next location.
    }
  }
  return null;
}
