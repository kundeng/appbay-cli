/**
 * `appbay init` command.
 *
 * Scaffolds the APPBAY_HOME directory structure, creates the shared Docker
 * network, copies system-app definitions, and writes the server compose file.
 *
 * Options:
 *   --dir <path>       custom APPBAY_HOME location (default: ~/.appbay)
 *   --project <name>   project name stored in project config
 *   --domain <name>    base domain for ingress routing
 *
 * Exit codes:
 *   0 -- scaffold created successfully
 *   1 -- scaffold creation failed
 */

import { Command } from "commander";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdir, stat, writeFile, readFile, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { statSync, readFileSync } from "node:fs";
import {
  SYSTEM_APPS,
  ContainerRuntimeSchema,
  DEFAULT_CONTAINER_RUNTIME,
  IngressProviderSchema,
  DEFAULT_INGRESS_PROVIDER,
  type IngressProvider,
  AcmeDnsProviderSchema,
  type AcmeDnsProvider,
  parseInstanceConfig,
  clearContainerRuntimeCache,
  containerStoreRoot,
  resolveIngressProvider,
  type ContainerRuntime,
  inspectEdgePorts,
} from "@appbay/core";
import { resolveAppbayHome, saveAppbayHome } from "../utils/appbay-home.js";
import { ask } from "../utils/prompt.js";
import { cliContainerBin, cliRuntimeProfile } from "../utils/docker.js";
import { resolveRuntimeSocket } from "./server.js";
import { runInitPreflight, requiredChecksFailed, formatCheck } from "../utils/checks.js";

/** Directories to create relative to APPBAY_HOME. */
const SCAFFOLD_DIRS = [
  "etc/apps",
  "var/lib/state",
  "var/lib/renders",
  "var/lib/catalog",
  "var/log",
  "var/cache",
  "bin",
  "share",
];

const BAKED_CATALOG_PATH = "/opt/appbay/catalog";
const DEFAULT_CATALOG_URL = "https://github.com/kundeng/appbay-catalog";

function resolveCatalogSource(explicit?: string): string {
  return explicit ?? process.env.APPBAY_CATALOG_SOURCE ?? DEFAULT_CATALOG_URL;
}

/** Docker network name used by all appbay apps. */
const SHARED_NETWORK = "appbay_shared";

/** Numbered step logger, matching setup.ts's `step(n,total,msg)`. */
function step(n: number, total: number, msg: string): void {
  console.log(`\n  [${n}/${total}] ${msg}`);
}

/**
 * The group that owns the container runtime's socket on THIS host, or null if the socket is
 * not there to be inspected.
 *
 * 🚨 MOUNTING THE SOCKET IS NOT THE SAME AS BEING ABLE TO USE IT. The server runs as
 * `uid:gid 1000:1000`, and the socket is `root:docker` mode 0660 — so the mount succeeded, the
 * container started, reported healthy, served the UI, and then every deploy failed with
 *
 *     permission denied while trying to connect to the docker API at unix:///var/run/docker.sock
 *
 * Web-driven deploys could not work on any standard install. The gid is host-specific (112 on
 * this Ubuntu VM, 999 elsewhere), so it cannot be a constant; it is read here, at the moment
 * the file is generated on the host it will run on.
 */
function resolveRuntimeSocketGid(): number | null {
  // ⚠️ ASK THE RESOLVER, DO NOT READ THE ENV VAR. `APPBAY_RUNTIME_SOCKET` is set by
  // `appbay server start`, not during `appbay init` — so reading it here would have
  // defaulted to /var/run/docker.sock on a Podman host, found nothing, emitted no
  // group_add, and reproduced the exact permission failure this function exists to
  // prevent. `resolveRuntimeSocket()` is the same function the server uses, and it
  // already knows the configured runtime and whether this is a rootful install.
  const socket = resolveRuntimeSocket();
  try {
    return statSync(socket).gid;
  } catch {
    // A missing socket is not an init failure — `appbay init` legitimately runs before the
    // runtime is up. Emitting no `group_add` is better than emitting a guessed one, which
    // would fail the container start rather than one deploy.
    return null;
  }
}

/**
 * SELinux posture for the control-plane container, from this installation's config.
 *
 * Defaults to `confined`: an install that has not opted out keeps confinement, and the
 * generated compose is byte-identical to what it was before this option existed.
 */
function resolveControlPlaneSelinux(appbayHome: string): "confined" | "unconfined" {
  try {
    const raw = readFileSync(join(appbayHome, "project.yaml"), "utf-8");
    const cfg = parseInstanceConfig(raw);
    return cfg.control_plane_selinux === "unconfined" ? "unconfined" : "confined";
  } catch {
    return "confined";
  }
}

/**
 * Minimal server compose file embedded for bootstrapping.
 *
 * This brings up the Next.js control plane server with direct Docker socket
 * access. The compose file is written to $APPBAY_HOME during init so that
 * `appbay server start` can find it.
 */
function serverComposeContent(
  socketGid: number | null,
  selinux: "confined" | "unconfined",
): string {
  // Overridable, because the gid recorded at init is only right for the host init ran on —
  // copying an APPBAY_HOME to another machine must not silently keep the old one.
  // Emitted ONLY when the operator has opted out of confinement for the control plane. The
  // default emits nothing, so a host that never sets this keeps full SELinux confinement and
  // the file reads exactly as it did before the option existed.
  const securityOptBlock =
    selinux === "unconfined"
      ? `    # ⚠️ SELinux confinement is DISABLED for this container because
    # control_plane_selinux: unconfined is set in project.yaml. Required on an Enforcing
    # host for the control plane to reach the runtime socket — a relabel is not sufficient,
    # the denial is connectto against the API service's process label. This is the most
    # privileged container in the system; see issue #58 for the policy-module alternative.
    security_opt:
      - label=disable
`
      : "";

  const socketGroupBlock =
    socketGid === null
      ? ""
      : `    # Supplementary group granting access to the mounted runtime socket. Read from the
    # socket's own owner at init time; see resolveRuntimeSocketGid.
    group_add:
      - "\${APPBAY_RUNTIME_SOCKET_GID:-${socketGid}}"
`;

  return `# Appbay server compose -- generated by "appbay init".
# Do not edit manually unless you know what you are doing.

name: appbay-server

services:
  server:
    container_name: appbay.server
    image: \${APPBAY_SERVER_IMAGE:-ghcr.io/kundeng/appbay-server:latest}
    user: "\${APPBAY_UID:-1000}:\${APPBAY_GID:-1000}"
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - APPBAY_HOME=/appbay
      # The server image deliberately ships one client. On Podman hosts that Docker client
      # speaks to the mounted Podman compatibility socket; app definitions remain unchanged.
      - APPBAY_CONTAINER_RUNTIME=\${APPBAY_SERVER_CONTAINER_RUNTIME:-docker}
      # The web server and offline appbay-admin recovery command share this
      # SQLite database. DATABASE_URL is not consumed by the current server.
      - APPBAY_DB=/appbay/var/lib/appbay.db
    volumes:
      # ⚠️ :z RELABELS THE BIND FOR SELINUX, AND IT IS NOT OPTIONAL. On an Enforcing host the
      # home tree is labelled user_home_t, which a container process cannot write — so the
      # server started, then died with SQLITE_CANTOPEN trying to create appbay.db, AS ROOT,
      # on an rw mount. Flipping SELinux to permissive made it writable, which is how this
      # was pinned down.
      # The compiler already does this for every app bind mount (appendSelinuxLabel in
      # upstream-transform.ts); the server's own compose was simply never given the same
      # treatment. Docker ignores the suffix on non-SELinux hosts, so it is unconditional
      # for the same reason it is there.
      - appbay-home:/appbay:z
      - \${APPBAY_RUNTIME_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock:ro
${socketGroupBlock}${securityOptBlock}    networks:
      - appbay_shared
    healthcheck:
      # Node is guaranteed to exist in the server image; curl is not present in
      # the minimal Alpine runner.
      #
      # 🚨 BLOCK SCALAR, NOT A QUOTED FLOW STRING. This was written as
      # \`test: ["CMD-SHELL", "node -e \\"fetch(…)\\""]\` — but those backslashes are
      # TYPESCRIPT escapes inside this template literal, so they disappear before the
      # file is written and the YAML ended up with bare nested double quotes:
      #
      #     test: ["CMD-SHELL", "node -e "fetch('http://…')…""]
      #
      # That is not parseable YAML, so \`docker compose\` rejected the ENTIRE file and
      # \`appbay server start\` failed on every install with
      # \`yaml: line 29: did not find expected ',' or ']'\`. The control plane could not
      # be started by the product's own command, on any host, ever. It went unnoticed
      # because every web journey ran \`pnpm --filter @appbay/web dev\` from the repo,
      # which never reads this file. A \`>-\` block scalar needs no inner quoting at all,
      # so there is nothing left to escape for the wrong language.
      test:
        - CMD-SHELL
        - >-
          node -e "fetch('http://localhost:3000/api/trpc/health.get').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  appbay-home:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: \${APPBAY_HOME_PATH:-~/.appbay}

networks:
  appbay_shared:
    external: true
`;
}

/**
 * Check whether a directory exists.
 */
async function dirExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check whether a file exists.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Create the shared container network if it does not already exist.
 *
 * ⚠️ The NOUN follows the configured runtime, the same way the binary does. This printed
 * `Docker network "appbay_shared" already exists.` on a Podman host — measured on
 * appbay-rhel — which is the S23 failure mode in miniature: the code did the right thing and
 * the report named the wrong product. An operator reading it has no way to tell whether
 * appbay is actually configured for Podman, which matters, because an install created
 * WITHOUT `--container-runtime podman` really does try to run `docker` and fails.
 *
 * @returns true if the network was created, false if it already existed.
 */
function ensureDockerNetwork(): boolean {
  // Check if network already exists.
  const inspect = spawnSync(cliContainerBin(), ["network", "inspect", SHARED_NETWORK], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (inspect.status === 0) return false;

  // Network does not exist; create it.
  const create = spawnSync(cliContainerBin(), ["network", "create", SHARED_NETWORK], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (create.status === 0) return true;

  const errMsg = create.stderr ? String(create.stderr).trim() : "unknown error";
  console.error(`  Warning: could not create ${cliRuntimeProfile().displayName} network: ${errMsg}`);
  return false;
}

/**
 * Seed built-in system app definitions into the apps directory.
 *
 * Uses the embedded SYSTEM_APPS definitions from @appbay/core so that
 * seeding works correctly in bun-compiled binaries (where filesystem
 * paths relative to the source tree are unavailable).
 */
async function seedSystemApps(
  appsDir: string,
  opts: { refresh?: boolean; edge: IngressProvider },
): Promise<{ seeded: string[]; stale: string[]; refreshed: string[] }> {
  const seeded: string[] = [];
  const stale: string[] = [];
  const refreshed: string[] = [];

  for (const app of SYSTEM_APPS) {
    if ((app.name === "traefik" || app.name === "caddy") && app.name !== opts.edge) {
      continue;
    }
    const appDir = join(appsDir, app.name);

    // 🚨 "INSTALLED" IS A COMPOSE FILE, NOT A DIRECTORY, and the difference is not
    // pedantry — it was a real bug found deploying on a VM.
    //
    // Traits write auxiliary files INTO the ingress provider's app directory:
    // etc/apps/<provider>/config/dynamic/<app>.caddy. So deploying any app with an
    // ingress trait CREATES etc/apps/caddy/ before caddy itself has been installed.
    // The old `dirExists(appDir)` check then saw that directory, concluded caddy was
    // already present, and skipped seeding it — permanently. `appbay up caddy` reported
    // "No apps found to deploy" against a directory containing one orphaned site block
    // and nothing else.
    //
    // Keying on docker-compose.yml — the file that actually makes a directory an app —
    // means a trait-created directory no longer masks an uninstalled system app.
    const composePath = join(appDir, "docker-compose.yml");
    if (await fileExists(composePath)) {
      // 🚨 INSTALLED IS NOT UP TO DATE, AND THE DIFFERENCE WAS INVISIBLE.
      // Skipping outright meant a SHIPPED definition change could never reach an existing
      // install: a new binary carrying a fixed compose file or a new trait would seed it on
      // fresh hosts only, and every converge on an existing host reported success while
      // deploying last month's definition. Measured twice on 2026-08-07 — once when the
      // a system app gained an ingress trait, once when caddy gained a build stage. Both
      // times the deploy was green and the change simply was not there.
      //
      // ⚠️ REPORTING is unconditional; REPLACING is opt-in. These files are appbay's, but
      // an operator may legitimately have edited one, and silently reverting that is the
      // worse failure. `--refresh-system-apps` is the explicit act; a converge that does not
      // ask still gets told.
      const drifted: string[] = [];
      for (const [filename, content] of Object.entries(app.files)) {
        const filePath = join(appDir, filename);
        const current = await readFile(filePath, "utf-8").catch(() => null);
        if (current !== content) drifted.push(filename);
      }
      if (drifted.length === 0) continue;

      if (!opts.refresh) {
        stale.push(`${app.name} (${drifted.join(", ")})`);
        continue;
      }

      for (const filename of drifted) {
        const filePath = join(appDir, filename);
        if (await fileExists(filePath)) {
          await rename(filePath, `${filePath}.bak`).catch(() => undefined);
        }
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, app.files[filename], "utf-8");
      }
      refreshed.push(`${app.name} (${drifted.join(", ")})`);
      continue;
    }

    await mkdir(appDir, { recursive: true });

    for (const [filename, content] of Object.entries(app.files)) {
      const filePath = join(appDir, filename);
      // ⚠️ Still never clobber a file that exists. A half-populated directory gets
      // completed, not reset — an operator's edited Caddyfile must survive.
      if (await fileExists(filePath)) continue;
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf-8");
    }

    seeded.push(app.name);
  }

  return { seeded, stale, refreshed };
}

/**
 * Write the server compose file to APPBAY_HOME if it does not already exist.
 *
 * @returns true if the file was written, false if it already existed.
 */
async function writeServerCompose(appbayHome: string): Promise<boolean> {
  const composePath = join(appbayHome, "docker-compose.server.yml");

  if (await fileExists(composePath)) {
    return false;
  }

  await writeFile(
    composePath,
    serverComposeContent(resolveRuntimeSocketGid(), resolveControlPlaneSelinux(appbayHome)),
    "utf-8",
  );
  return true;
}

/**
 * Seed the bundled catalog into the catalog directory.
 *
 * Priority:
 *   1. Baked-in path (Docker image: /opt/appbay/catalog/) — copy
 *   2. Git clone from the default catalog URL
 *
 * Skips if the bundled catalog dir already has content.
 */
async function seedCatalog(appbayHome: string, catalogSource: string): Promise<"baked" | "cloned" | "linked" | "copied" | "exists" | "skipped"> {
  const bundledDir = join(appbayHome, "var", "lib", "catalog", "bundled");

  // Already seeded?
  try {
    const { readdir } = await import("node:fs/promises");
    const existing = await readdir(bundledDir);
    if (existing.length > 0) return "exists";
  } catch {
    // Dir doesn't exist or empty — proceed
  }

  // Try baked-in path first (Docker image)
  if (await dirExists(BAKED_CATALOG_PATH)) {
    const { cp } = await import("node:fs/promises");
    await mkdir(bundledDir, { recursive: true });
    await cp(BAKED_CATALOG_PATH, bundledDir, { recursive: true });
    return "baked";
  }

  // Local path: symlink or copy
  if (await dirExists(catalogSource)) {
    await mkdir(dirname(bundledDir), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    try {
      await symlink(catalogSource, bundledDir);
      return "linked";
    } catch {
      const { cp } = await import("node:fs/promises");
      await mkdir(bundledDir, { recursive: true });
      await cp(catalogSource, bundledDir, { recursive: true });
      return "copied";
    }
  }

  // Git URL: clone
  const result = spawnSync(
    "git",
    ["clone", "--depth", "1", catalogSource, bundledDir],
    { stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 },
  );
  if (result.status === 0) return "cloned";

  return "skipped";
}

/** Write project.yaml with project name and domain. */
async function writeProjectConfig(
  appbayHome: string,
  project: string,
  domain: string,
  catalogSource?: string,
  containerRuntime?: ContainerRuntime,
  ingressProvider?: IngressProvider,
  acmeDnsProvider?: AcmeDnsProvider,
): Promise<boolean> {
  const configPath = join(appbayHome, "project.yaml");
  if (await fileExists(configPath)) {
    return false;
  }
  let content = `# Appbay project configuration — generated by "appbay init"
project: ${project}
domain: ${domain}
`;
  if (catalogSource && catalogSource !== DEFAULT_CATALOG_URL) {
    content += `catalog_source: ${catalogSource}\n`;
  }
  if (containerRuntime && containerRuntime !== DEFAULT_CONTAINER_RUNTIME) {
    content += `container_runtime: ${containerRuntime}\n`;
  }
  if (ingressProvider && ingressProvider !== DEFAULT_INGRESS_PROVIDER) {
    content += `ingress_provider: ${ingressProvider}\n`;
  }
  // ⚠️ No default to compare against — absent means "no DNS-01", which is a real choice.
  if (acmeDnsProvider) {
    content += `acme_dns_provider: ${acmeDnsProvider}\n`;
  }
  await writeFile(configPath, content, "utf-8");
  return true;
}

/**
 * Set `container_runtime` in an EXISTING project.yaml.
 *
 * ⚠️ This exists because `writeProjectConfig` returns early when the file is
 * present, so re-running `appbay init` cannot change anything. That is fine for
 * project/domain — renaming a live install by re-init would be a nasty surprise —
 * but it makes `--container-runtime` useless on any host that has ever been
 * initialised, which is exactly the host a configuration-management run targets.
 *
 * ⚠️ Line-based upsert, NOT parse-and-restringify. Round-tripping through the
 * YAML writer would discard the generated-by header and any comment an operator
 * added, and silently reformat keys this version does not know about. Rewriting a
 * user's file as a side effect of setting one key is worse than the duplication.
 *
 * @returns "created" | "updated" | "unchanged" — so the caller can report
 *   honestly, and so an automation driver can derive changed state from a
 *   read-back rather than from an exit code.
 */
export async function upsertContainerRuntime(
  appbayHome: string,
  runtime: ContainerRuntime,
): Promise<"created" | "updated" | "unchanged"> {
  return upsertInstanceKey(appbayHome, "container_runtime", runtime, DEFAULT_CONTAINER_RUNTIME);
}

/** Same, for the ingress provider. */
export async function upsertIngressProvider(
  appbayHome: string,
  provider: IngressProvider,
): Promise<"created" | "updated" | "unchanged"> {
  return upsertInstanceKey(appbayHome, "ingress_provider", provider, DEFAULT_INGRESS_PROVIDER);
}

/**
 * Record which container STORE this install is bound to (#58 R3).
 *
 * 🚨 THIS IS WHAT MAKES A LATER MISMATCH DETECTABLE. `container_runtime: podman`
 * was already recorded and was not enough: rootful and rootless podman keep
 * separate stores, so an install created by an ordinary user put `appbay_shared`
 * in `~/.local/share/containers/storage` while `sudo appbay up` looked in
 * `/var/lib/containers/storage` and reported
 * `External network [appbay_shared] does not exists` — a message with nothing in
 * it pointing back at the choice made during init.
 *
 * ⚠️ MUST run AFTER the runtime key is settled, because the store root is read by
 * asking the configured binary. Recording it before a `--container-runtime podman`
 * takes effect would store the DOCKER daemon's root under a podman install and
 * fail every check afterwards.
 *
 * ⚠️ Its default is the EMPTY STRING for the same reason as the ACME provider:
 * there is no default store root, so "setting it to the default" is not a case
 * that can arise. A null probe (runtime not answering) writes nothing at all —
 * recording "unknown" would be worse than recording nothing, because the check
 * treats absent as "never asked" and would treat a literal "unknown" as a path.
 */
export async function upsertContainerStore(
  appbayHome: string,
  store: string,
): Promise<"created" | "updated" | "unchanged"> {
  return upsertInstanceKey(appbayHome, "container_store", store, "");
}

/** Same, for the ACME DNS-01 provider. */
export async function upsertAcmeDnsProvider(
  appbayHome: string,
  provider: AcmeDnsProvider,
): Promise<"created" | "updated" | "unchanged"> {
  // ⚠️ Its own default is the EMPTY STRING, not a provider name: there is no default
  // DNS-01 provider, so "setting it to the default" can never be the case that
  // upsertInstanceKey's third branch handles.
  return upsertInstanceKey(appbayHome, "acme_dns_provider", provider, "");
}

/**
 * Set one key in an EXISTING project.yaml.
 *
 * ⚠️ Generic over the key because there are now two of these and there will be more.
 * A second hand-written copy of the line editor is how the two drift — one gains a fix
 * for a trailing-newline edge case and the other does not.
 */
async function upsertInstanceKey(
  appbayHome: string,
  key: "container_runtime" | "ingress_provider" | "acme_dns_provider" | "container_store",
  value: string,
  defaultValue: string,
): Promise<"created" | "updated" | "unchanged"> {
  const configPath = join(appbayHome, "project.yaml");
  const text = await readFile(configPath, "utf-8");

  const current = parseInstanceConfig(text)[key];
  if (current === value) return "unchanged";
  // An absent key means the default is in effect; setting it TO the default is
  // still worth writing, because it makes the choice explicit and auditable.
  if (current === undefined && value === defaultValue) {
    // Nothing is currently wrong, but record the intent rather than leave the
    // value implicit — a host whose runtime is unstated reads as "unknown" to
    // the next operator.
    const appended = text.endsWith("\n") ? text : text + "\n";
    await writeFile(configPath, appended + `${key}: ${value}\n`, "utf-8");
    return "created";
  }

  const line = `${key}: ${value}`;
  const replaced = text.replace(new RegExp(`^${key}:.*$`, "m"), line);
  const next = replaced === text
    ? (text.endsWith("\n") ? text : text + "\n") + line + "\n"
    : replaced;

  await writeFile(configPath, next, "utf-8");
  return current === undefined ? "created" : "updated";
}

/** Read existing project.yaml to get project/domain for re-init. */
async function readProjectConfig(
  appbayHome: string,
): Promise<{ project?: string; domain?: string }> {
  const configPath = join(appbayHome, "project.yaml");
  try {
    const text = await readFile(configPath, "utf-8");
    const projectMatch = text.match(/^project:\s*(.+)$/m);
    const domainMatch = text.match(/^domain:\s*(.+)$/m);
    return {
      project: projectMatch?.[1]?.trim(),
      domain: domainMatch?.[1]?.trim(),
    };
  } catch {
    return {};
  }
}

export const initCommand = new Command("init")
  .description("Initialize Appbay home directory scaffold")
  .option("--dir <path>", "custom APPBAY_HOME location")
  .option("--project <name>", "project name")
  .option("--domain <name>", "base domain for ingress routing")
  .option("--catalog <source>", "catalog source: local path or git URL")
  .option(
    "--container-runtime <runtime>",
    'container binary to invoke: "docker" or "podman" (default: docker)',
  )
  .option(
    "--refresh-system-apps",
    "Replace installed system-app files that differ from what this version ships (.bak kept).",
  )
  .option(
    "--acme-dns-provider <provider>",
    "DNS provider for the ACME DNS-01 challenge (cloudflare). Absent means no DNS-01.",
  )
  .option(
    "--ingress-provider <provider>",
    'reverse proxy to emit config for: "traefik" or "caddy" (default: traefik)',
  )
  .option("--yes", "non-interactive: accept all defaults")
  .option(
    "--force",
    "skip the preflight gate and continue even if a required environment check fails",
  )
  .action(
    async (options: {
      dir?: string;
      project?: string;
      domain?: string;
      catalog?: string;
      containerRuntime?: string;
      ingressProvider?: string;
      acmeDnsProvider?: string;
      refreshSystemApps?: boolean;
      yes?: boolean;
      force?: boolean;
    }) => {
      const isInteractive = !options.yes && process.stdin.isTTY;

      // ── Preflight gate ──────────────────────────────────────────────────
      // Run the environment-level required checks BEFORE any scaffolding. If a
      // required check fails, print the failures + fixes and abort unless
      // --force is given. This is a gate, not a plan engine (D1): init is a
      // small, mostly-idempotent scaffold, so we only verify the environment
      // can support it, then proceed.
      //
      // The mental model: appbay never CREATES system accounts or sets ACLs —
      // that is Ansible's job on a fleet, and `init-system`'s one-time job on a
      // standalone host. Whether appbay runs as your user (standalone) or as
      // root via Ansible (fleet) is a deployment choice. The gate checks (1)
      // the container binary is installed, and (2) the current user can reach
      // the daemon WITHOUT sudo. If (2) fails because the daemon needs sudo,
      // the fix is group membership — not running appbay under sudo.
      // Validate --container-runtime BEFORE any scaffolding happens. A typo must
      // not leave a half-initialised home behind, and failing after the mkdir
      // would do exactly that.
      let containerRuntime: ContainerRuntime | undefined;
      if (options.containerRuntime !== undefined) {
        const parsed = ContainerRuntimeSchema.safeParse(options.containerRuntime.trim());
        if (!parsed.success) {
          console.error(
            `Invalid --container-runtime "${options.containerRuntime}" — expected "docker" or "podman".`,
          );
          process.exit(1);
        }
        containerRuntime = parsed.data;
      }

      // 🚨 APPLY THE SELECTED RUNTIME BEFORE THE PREFLIGHT THAT TESTS IT. This parsing used
      // to sit AFTER the preflight, so `appbay init --container-runtime podman` probed for
      // DOCKER — on a Podman-only host the documented bootstrap command reported
      //     ✗ Docker  Docker not found
      //     Fix: Install Docker: https://docs.docker.com/get-docker/
      // and refused to initialise, while the very flag that would have made it look for
      // Podman sat unread twenty lines below. The only way through was to know to export
      // APPBAY_CONTAINER_RUNTIME instead, which is not documented anywhere.
      //
      // The resolver reads config, then environment; nothing is on disk yet at this point,
      // so the environment is how the choice reaches it. The cache must be cleared because
      // an earlier call in this process may already have resolved the default.
      if (containerRuntime) {
        process.env.APPBAY_CONTAINER_RUNTIME = containerRuntime;
        clearContainerRuntimeCache();
      }

      if (!options.force) {
        const preflight = await runInitPreflight();
        const failed = requiredChecksFailed(preflight);
        if (failed.length > 0) {
          console.log("Preflight check failed — cannot initialize Appbay:\n");
          for (const check of preflight) {
            if (!check.passed) console.log(formatCheck(check));
          }
          console.log("");
          console.log(
            "If a check says the daemon needs sudo, add your user to the container group " +
              "(or run \"appbay init-system\" on a standalone host) rather than running appbay " +
              "under sudo. On an Ansible-managed fleet, Ansible arranges access. " +
              "appbay itself never creates system accounts or sets ACLs.",
          );
          console.log("");
          console.log("Fix the issues above, then re-run. Or use --force to continue anyway.");
          process.exit(1);
        }
      }

      let ingressProvider: IngressProvider | undefined;
      if (options.ingressProvider !== undefined) {
        const parsed = IngressProviderSchema.safeParse(options.ingressProvider.trim());
        if (!parsed.success) {
          console.error(
            `Invalid --ingress-provider "${options.ingressProvider}" — expected "traefik" or "caddy".`,
          );
          process.exit(1);
        }
        ingressProvider = parsed.data;
      }

      let acmeDnsProvider: AcmeDnsProvider | undefined;
      if (options.acmeDnsProvider !== undefined) {
        const parsed = AcmeDnsProviderSchema.safeParse(options.acmeDnsProvider.trim());
        if (!parsed.success) {
          console.error(
            `Invalid --acme-dns-provider "${options.acmeDnsProvider}" — expected "cloudflare".`,
          );
          process.exit(1);
        }
        acmeDnsProvider = parsed.data;
      }

      // ── Resolve APPBAY_HOME (3-tier: env > --dir/prompt > default) ──────
      let appbayHome: string;
      if (process.env.APPBAY_HOME) {
        // Env var always wins — no prompt, no save (it's ephemeral by nature).
        appbayHome = process.env.APPBAY_HOME;
      } else if (options.dir) {
        // Explicit --dir: use it and persist for future invocations.
        appbayHome = options.dir;
        saveAppbayHome(appbayHome);
      } else {
        // No explicit path: ask on first interactive run, else use default.
        const defaultHome = join(homedir(), ".appbay");
        if (isInteractive && !(await dirExists(defaultHome))) {
          // First-ever run: give the user a chance to choose the data dir.
          console.log("Welcome to Appbay!\n");
          appbayHome = await ask("Where should Appbay store its data?", defaultHome);
          saveAppbayHome(appbayHome);
          console.log("");
        } else {
          // Re-init or non-interactive: resolveAppbayHome picks up the saved config.
          appbayHome = resolveAppbayHome();
        }
      }

      const appsDir = join(appbayHome, "etc", "apps");
      const isFreshInstall = !(await dirExists(appbayHome));

      console.log(`Initializing Appbay in ${appbayHome}\n`);

      // ── Interactive prompts on fresh install ────────────────────────────
      let projectName = options.project ?? "";
      let domain = options.domain ?? "";

      if (isFreshInstall && isInteractive) {
        if (!projectName) {
          const hostname = (() => {
            const r = spawnSync("hostname", ["-s"], { stdio: "pipe", encoding: "utf-8" });
            return r.status === 0 ? String(r.stdout).trim() || "homelab" : "homelab";
          })();
          projectName = await ask("Project name", hostname);
        }

        if (!domain) {
          domain = await ask("Base domain (for ingress routing)", "local");
        }

        console.log("");
      } else if (!isFreshInstall) {
        // Re-init: read existing config for defaults
        const existing = await readProjectConfig(appbayHome);
        projectName = options.project ?? existing.project ?? "";
        domain = options.domain ?? existing.domain ?? "";
      }

      // Apply defaults if still empty
      if (!projectName) projectName = "homelab";
      if (!domain) domain = "local";

      // Stage 1: Create directory scaffold.
      step(1, 6, "Creating directory scaffold");
      const created: string[] = [];
      for (const rel of SCAFFOLD_DIRS) {
        const dir = join(appbayHome, rel);
        const exists = await dirExists(dir);
        await mkdir(dir, { recursive: true });
        if (!exists) {
          created.push(rel);
        }
      }

      if (created.length > 0) {
        console.log("  Created directories:");
        for (const dir of created) {
          console.log(`    ${dir}/`);
        }
      } else {
        console.log("  All directories already exist.");
      }

      // Stage 2: Docker network.
      step(2, 6, `Ensuring shared ${cliRuntimeProfile().displayName} network`);
      const networkCreated = ensureDockerNetwork();
      if (networkCreated) {
        console.log(`  Created ${cliRuntimeProfile().displayName} network: ${SHARED_NETWORK}`);
      } else {
        console.log(`  ${cliRuntimeProfile().displayName} network "${SHARED_NETWORK}" already exists.`);
      }

      // Stage 3: Seed system apps from embedded definitions.
      step(3, 6, "Seeding system apps");
      const sys = await seedSystemApps(appsDir, {
        refresh: options.refreshSystemApps === true,
        edge: ingressProvider ?? resolveIngressProvider(appbayHome),
      });
      if (sys.seeded.length > 0) {
        console.log("  Seeded system apps:");
        for (const name of sys.seeded) console.log(`    ${name}`);
      }
      if (sys.refreshed.length > 0) {
        console.log("  Refreshed system apps (previous files kept as .bak):");
        for (const name of sys.refreshed) console.log(`    ${name}`);
      }
      // ⚠️ A WARNING, NOT A FAILURE, AND NOT SILENCE. An install running an older shipped
      // definition still works — it is just not what this binary ships, and until now there
      // was no way to find that out except by reading the files.
      if (sys.stale.length > 0) {
        console.log("  ⚠ System apps differ from what this appbay version ships:");
        for (const name of sys.stale) console.log(`    ${name}`);
        console.log("    Re-run with --refresh-system-apps to replace them (.bak kept).");
      }
      if (sys.seeded.length === 0 && sys.refreshed.length === 0 && sys.stale.length === 0) {
        console.log("  System apps already present and up to date.");
      }

      // Stage 4: Seed catalog.
      step(4, 6, "Seeding catalog");
      const catalogSrc = resolveCatalogSource(options.catalog);
      const catalogResult = await seedCatalog(appbayHome, catalogSrc);
      switch (catalogResult) {
        case "baked":
          console.log("  Seeded catalog from bundled data.");
          break;
        case "cloned":
          console.log("  Cloned catalog from " + catalogSrc);
          break;
        case "linked":
          console.log("  Linked catalog from " + catalogSrc);
          break;
        case "copied":
          console.log("  Copied catalog from " + catalogSrc);
          break;
        case "exists":
          console.log("  Catalog already present.");
          break;
        case "skipped":
          console.log("  Catalog not seeded (source unavailable: " + catalogSrc + ")");
          console.log("  You can add it later: appbay init --catalog /path/to/catalog");
          break;
      }

      // Stage 5: Write server compose file.
      step(5, 6, "Writing server compose");
      const composeWritten = await writeServerCompose(appbayHome);
      if (composeWritten) {
        console.log("  Wrote docker-compose.server.yml");
      } else {
        console.log("  docker-compose.server.yml already exists.");
      }

      // Stage 6: Write project.yaml.
      step(6, 6, "Writing project config");
      const configWritten = await writeProjectConfig(
        appbayHome,
        projectName,
        domain,
        catalogSrc,
        containerRuntime,
        ingressProvider,
        acmeDnsProvider,
      );
      if (configWritten) {
        console.log(`  Project: ${projectName}`);
        console.log(`  Domain:  ${domain}`);
        if (containerRuntime) console.log(`  Runtime: ${containerRuntime}`);
        if (ingressProvider) console.log(`  Ingress: ${ingressProvider}`);
        if (acmeDnsProvider) console.log(`  ACME DNS: ${acmeDnsProvider}`);
        console.log("  Wrote project.yaml");
      } else {
        console.log(`  Project config already exists (project: ${projectName}, domain: ${domain})`);
        // The file survived, so writeProjectConfig ignored the runtime. Apply it
        // separately — re-init on an existing host is the normal case for a
        // configuration-management run, and silently dropping the flag there
        // would be the worst of both behaviours.
        if (containerRuntime) {
          const outcome = await upsertContainerRuntime(appbayHome, containerRuntime);
          clearContainerRuntimeCache(appbayHome);
          console.log(
            outcome === "unchanged"
              ? `  Runtime: ${containerRuntime} (already set)`
              : `  Runtime: ${containerRuntime} (${outcome})`,
          );
        }
        if (ingressProvider) {
          const outcome = await upsertIngressProvider(appbayHome, ingressProvider);
          clearContainerRuntimeCache(appbayHome);
          console.log(
            outcome === "unchanged"
              ? `  Ingress: ${ingressProvider} (already set)`
              : `  Ingress: ${ingressProvider} (${outcome})`,
          );

          // 🚨 CHANGING THIS KEY DOES NOT MOVE A RUNNING EDGE. The previous proxy keeps
          // running and keeps holding :80/:443, so the new one cannot bind and apps
          // recompile to configuration the running proxy never reads — with every command
          // reporting success. Say so at the moment the key changes, while the operator is
          // still looking.
          //
          // ⚠️ `init` deliberately does NOT migrate. It is a small, idempotent scaffold;
          // turning it into a plan-and-execute engine was considered and rejected (see
          // work-notes D1). Detect, describe, and hand off.
          // ⚠️ Do NOT key this on `outcome`. Switching away from the DEFAULT provider
          // returns "created", not "updated", because the default is never written to
          // project.yaml — so the most common migration (default traefik -> caddy) would
          // skip the warning entirely. Measured on a live VM.
          //
          // Key on reality instead: is some OTHER edge holding the ports right now?
          {
            const previous: IngressProvider = ingressProvider === "caddy" ? "traefik" : "caddy";
            const held = inspectEdgePorts(previous, appbayHome).filter(
              (p) => p.heldBy !== null && p.isOutgoingEdge,
            );
            if (held.length > 0) {
              console.log("");
              console.log(`  ⚠️  The ${previous} edge is still running and holds ` +
                held.map((p) => `:${p.port}`).join(" and ") + ".");
              console.log(`      This flag changed configuration only — nothing was migrated.`);
              console.log(`      ${ingressProvider} cannot bind those ports while ${previous} holds them,`);
              console.log(`      and a bind failure looks like a successful deploy with a missing edge.`);
              console.log("");
              console.log(`      Stop the old edge before deploying the new one:`);
              console.log(`          appbay down ${previous}`);
              console.log(`          appbay up ${ingressProvider}`);
            }
          }
        }
        if (acmeDnsProvider) {
          const outcome = await upsertAcmeDnsProvider(appbayHome, acmeDnsProvider);
          clearContainerRuntimeCache(appbayHome);
          console.log(
            outcome === "unchanged"
              ? `  ACME DNS: ${acmeDnsProvider} (already set)`
              : `  ACME DNS: ${acmeDnsProvider} (${outcome})`,
          );
        }
      }

      // ── Record the container STORE this install is bound to (#58 R3) ────────
      //
      // 🚨 OUTSIDE the if/else on purpose. Both branches must record it: a fresh
      // install needs the binding written, and a RE-INIT is the documented way to
      // rebind an install to the store you are actually on — which is exactly what
      // the `store binding` check's remediation tells the operator to run. Putting
      // this inside `if (configWritten)` would make that remediation a no-op on
      // every host that has ever been initialised, i.e. every host that can hit
      // the mismatch in the first place.
      //
      // Runs LAST so the runtime key above is already applied and the cache cleared.
      {
        clearContainerRuntimeCache(appbayHome);
        const store = containerStoreRoot(appbayHome);
        if (store) {
          const outcome = await upsertContainerStore(appbayHome, store);
          clearContainerRuntimeCache(appbayHome);
          if (outcome === "updated") {
            // A CHANGED binding is the interesting case and must not scroll past as
            // a status line: the apps and networks of the previous store are still
            // in it, and this install can no longer see them.
            console.log("");
            console.log(`  ⚠️  Store binding CHANGED — this install now points at`);
            console.log(`      ${store}`);
            console.log(`      Anything created in the previous store stays there;`);
            console.log(`      init does not migrate containers, volumes or networks.`);
          } else {
            console.log(`  Store:   ${store}${outcome === "unchanged" ? " (already set)" : ""}`);
          }
        } else {
          // Not fatal: init must work on a host whose daemon is not up yet, and
          // `doctor` reports the unreachable runtime under runtime-access. Absent
          // reads as "never recorded", which the check passes rather than blocks.
          console.log(`  Store:   not recorded — runtime not answering (run "appbay doctor")`);
        }
      }

      // Summary and next steps.
      console.log(`
Appbay initialized at ${appbayHome}

Next steps:
  appbay doctor        Check prerequisites
  appbay catalog list  Browse available apps
  appbay install <app> Install an app from the catalog
  appbay server start  Start the control plane
  appbay list          See installed apps
`);
    },
  );
