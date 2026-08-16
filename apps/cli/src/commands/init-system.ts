/**
 * `appbay init-system` command.
 *
 * Standalone-host convenience for bootstrapping a fresh box to run Appbay the
 * SAME way the DGX fleet does (D-6 model): a dedicated no-login SYSTEM service
 * account, correct ownership, and group access via POSIX default ACLs. It
 * installs Docker (RHEL-family first), creates the service account + group,
 * sets ownership + ACLs on APPBAY_HOME, and installs systemd units.
 *
 * ⚠️ BOUNDARY: this is a convenience for a single binary on a fresh host with
 * NO Ansible. For the DGX fleet, ansible remains authoritative — `init-system`
 * is tested to work, but the fleet path is ansible substrate, not this command.
 * On the fleet, Ansible creates the `llmsvc` service account (uid 950) and the
 * D-6 uid/ACL model; appbay consumes it as data and never creates system
 * accounts or sets ACLs itself. `init-system` is the one place appbay does
 * that work, precisely because there is no Ansible on a standalone host — and
 * it must do it the D-6 way: a system uid (<1000, never a human's), no login,
 * no home, setgid group-writable ownership, and default ACLs with `other::---`.
 *
 * Options:
 *   --dry-run        show what would change without running any sudo command.
 *   --service-user   service account name (default: appbay).
 *   --service-uid    system uid for the service account (default: 950).
 *
 * Exit codes:
 *   0 -- bootstrap complete (or dry-run plan printed)
 *   1 -- unsupported distro, or a step failed
 */

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { SYSTEM_CONFIG_FILE, SYSTEM_CONFIG_DIR } from "../utils/system-config.js";
import { cliContainerBin } from "../utils/docker.js";

/** Default service account name. */
export const DEFAULT_SERVICE_USER = "appbay";
/** Default system uid for the service account (D-6: <1000, never a human's). */
export const DEFAULT_SERVICE_UID = 950;
/** Default system home for service mode (NOT under the operator's home). */
export const DEFAULT_SERVICE_HOME = "/var/lib/appbay";

/** Commander option collector for repeatable flags (e.g. --group a --group b). */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** A single bootstrap action. */
export interface SystemAction {
  id: string;
  label: string;
  /** Whether this action would change anything on this host. */
  wouldChange: boolean;
  /** The sudo command to run when applying. Empty when wouldChange is false. */
  command: string[];
  /** Optional content piped to the command's stdin (e.g. for `sudo tee`). */
  stdin?: string;
}

/** Result of distro detection. */
export interface DistroInfo {
  /** "rhel" | "debian" | "unknown" */
  family: "rhel" | "debian" | "unknown";
  /** Pretty name from /etc/os-release, e.g. "Rocky Linux 9.4". */
  prettyName: string;
  /** Package manager: "dnf" | "apt" | null. */
  pkgManager: "dnf" | "apt" | null;
  /** Raw ID= from /etc/os-release ("fedora", "rocky", …) — the docker-ce repo is per-distro. */
  id: string;
}

/**
 * Detect the host distro from /etc/os-release.
 *
 * RHEL-family-first per the spec (matches prod). Debian is detected so the
 * command can report a clear boundary rather than guessing, but only RHEL
 * family is actually bootstrapped.
 */
export function detectDistro(): DistroInfo {
  let id = "";
  let idLike = "";
  let prettyName = "unknown";
  try {
    const text = readFileSync("/etc/os-release", "utf-8");
    for (const line of text.split("\n")) {
      if (line.startsWith("ID=")) id = line.slice(3).replace(/"/g, "").trim();
      else if (line.startsWith("ID_LIKE=")) idLike = line.slice(8).replace(/"/g, "").trim();
      else if (line.startsWith("PRETTY_NAME=")) prettyName = line.slice(12).replace(/"/g, "").trim();
    }
  } catch {
    // Not a Linux host (or no os-release) — report unknown.
  }

  const rhelIds = ["rhel", "centos", "rocky", "alma", "fedora", "ol", "amzn"];
  const debianIds = ["debian", "ubuntu"];

  if (rhelIds.includes(id) || idLike.split(/\s+/).some((x) => rhelIds.includes(x))) {
    return { family: "rhel", prettyName, pkgManager: "dnf", id };
  }
  if (debianIds.includes(id) || idLike.split(/\s+/).some((x) => debianIds.includes(x))) {
    return { family: "debian", prettyName, pkgManager: "apt", id };
  }
  return { family: "unknown", prettyName, pkgManager: null, id };
}

/** Whether a command exists on PATH. */
function commandExists(cmd: string): boolean {
  return spawnSync("which", [cmd], { stdio: "pipe" }).status === 0;
}

/** Whether a systemd unit file exists. */
function unitExists(name: string): boolean {
  return existsSync(`/etc/systemd/system/${name}`);
}

/** Whether a systemd service is enabled. */
function serviceEnabled(name: string): boolean {
  const r = spawnSync("systemctl", ["is-enabled", name], { stdio: "pipe" });
  return r.status === 0 && String(r.stdout).trim() === "enabled";
}

/** Whether a user or group exists. */
function userExists(name: string): boolean {
  return spawnSync("id", [name], { stdio: "pipe" }).status === 0;
}

/** Whether a group exists. */
function groupExists(name: string): boolean {
  return spawnSync("getent", ["group", name], { stdio: "pipe" }).status === 0;
}

/** Whether a user is a member of a group. */
function userInGroup(user: string, group: string): boolean {
  const r = spawnSync("id", ["-nG", user], { stdio: "pipe" });
  if (r.status !== 0) return false;
  return String(r.stdout).split(/\s+/).includes(group);
}

/** Whether a directory is owned by the given user. */
function dirOwnedBy(path: string, user: string): boolean {
  const r = spawnSync("stat", ["-c", "%U", path], { stdio: "pipe" });
  return r.status === 0 && String(r.stdout).trim() === user;
}

/** Whether a directory is group-owned by the given group. */
function dirGroupOwnedBy(path: string, group: string): boolean {
  const r = spawnSync("stat", ["-c", "%G", path], { stdio: "pipe" });
  return r.status === 0 && String(r.stdout).trim() === group;
}

/** Whether a directory is setgid (mode 2xxx). */
function dirSetgid(path: string): boolean {
  const r = spawnSync("stat", ["-c", "%a", path], { stdio: "pipe" });
  if (r.status !== 0) return false;
  const mode = String(r.stdout).trim();
  return mode.length === 4 && mode[0] === "2";
}

/**
 * Build the plan of bootstrap actions for this host.
 *
 * The ownership model is a single axis — "who owns the appbay tree, and who
 * else gets access" — expressed as one `owner` flag plus refinements, NOT a
 * schema. Three tiers fall out of it:
 *
 *   • `--owner operator` (personal): the operator's own user owns everything.
 *     No service account, no group ACLs. The degenerate case where the owner
 *     IS the operator.
 *   • `--owner service` (default, homelab/worklab): a dedicated no-login SYSTEM
 *     service account owns the tree (the D-6 model the DGX fleet uses, spec 10
 *     §4.7). `--group` grants a team group access via default ACLs.
 *   • DGX fleet: Ansible is authoritative; `init-system` does not run there.
 *
 * Pure-ish: reads host state (docker present, user present, units present) and
 * returns the actions that would change something. `--dry-run` prints this
 * plan; a real run executes each action's command.
 *
 * The plan is computed SEQUENTIALLY: each step's `wouldChange` reflects the
 * state after the preceding steps have applied, not the raw current state.
 * Otherwise a fresh host (no service account yet) would skip the docker-group
 * step that must run after create-user.
 */
export function planSystemBootstrap(opts?: {
  owner?: "operator" | "service";
  serviceUser?: string;
  serviceUid?: number;
  groups?: string[];
  home?: string;
}): SystemAction[] {
  const owner = opts?.owner ?? "service";
  const serviceUser = opts?.serviceUser ?? DEFAULT_SERVICE_USER;
  const serviceUid = opts?.serviceUid ?? DEFAULT_SERVICE_UID;
  const groups = opts?.groups ?? [];
  const actions: SystemAction[] = [];

  // The user that owns the appbay tree. In operator mode that is the operator
  // themselves; in service mode it is the dedicated service account.
  const ownerUser = owner === "service" ? serviceUser : process.env.USER ?? "root";

  // The appbay tree location. In service mode this must NOT be under the
  // operator's home (~/appbay) — the service account cannot own a path inside
  // a human's home. The caller passes the resolved home (defaulting to a system
  // path for service mode); fall back to the normal resolver.
  const home = opts?.home ?? resolveAppbayHome();

  // Track state as it will be after each step, so later steps decide against
  // the post-bootstrap state rather than the raw current state.
  let dockerWillExist = commandExists("docker");
  let svcWillExist = userExists(serviceUser);

  // 1. Container runtime.
  //
  // 🚨 THIS USED TO INSTALL docker-ce UNCONDITIONALLY, AND ON RHEL-FAMILY HOSTS THAT IS
  // BOTH WRONG AND BROKEN. Measured on a stock Fedora 43 cloud image:
  //     sudo dnf -q info docker-ce   ->  "No matching packages to list"
  // docker-ce lives in Docker's OWN repo, which this command never added, so the very
  // first bootstrap step could not succeed on the distro family the command exists for.
  // Meanwhile the host already shipped podman 5.6.2, and `appbay doctor` was telling
  // Podman users to run this command "to install it" — it would have installed Docker.
  //
  // ⭐ S23 SETTLED THIS: the container runtime is CONFIGURATION, not a hardcoded choice.
  // Bootstrap therefore installs whatever runtime the install is configured for, exactly
  // like every other spawn site resolving through the runtime resolver.
  const runtime = cliContainerBin();
  const runtimeIsPodman = runtime === "podman";
  let runtimeWillExist = commandExists(runtime);

  if (!runtimeWillExist) {
    if (runtimeIsPodman) {
      // Fedora/RHEL ship podman and a compose provider in their own repos — no third-party
      // repo needed, which is the whole reason RHEL-family is the Podman target.
      actions.push({
        id: "install-runtime",
        label: "Install Podman + compose provider (dnf)",
        wouldChange: true,
        command: ["dnf", "install", "-y", "podman", "podman-compose"],
      });
    } else {
      // ⚠️ The repo step is NOT optional. Without it the install below fails outright on
      // any RHEL-family host; see the measurement above.
      actions.push({
        id: "add-docker-repo",
        label: "Add Docker CE repository (docker-ce is not in RHEL-family repos)",
        wouldChange: true,
        command: [
          "dnf", "config-manager", "--add-repo",
          // Docker publishes a fedora repo and a centos repo; every other RHEL-family
          // distro (rocky, alma, ol, amzn) is served by the centos one.
          `https://download.docker.com/linux/${detectDistro().id === "fedora" ? "fedora" : "centos"}/docker-ce.repo`,
        ],
      });
      actions.push({
        id: "install-runtime",
        label: "Install Docker Engine (dnf)",
        wouldChange: true,
        command: [
          "dnf", "install", "-y", "docker-ce", "docker-ce-cli", "containerd.io",
          "docker-buildx-plugin", "docker-compose-plugin",
        ],
      });
    }
    runtimeWillExist = true;
  } else {
    actions.push({
      id: "install-runtime",
      label: `${runtimeIsPodman ? "Podman" : "Docker Engine"} already installed`,
      wouldChange: false,
      command: [],
    });
  }
  dockerWillExist = runtimeWillExist && !runtimeIsPodman;

  // 1b. Compose provider — SEPARATE from the runtime, because it is separately missing.
  //
  // 🚨 Fedora cloud images ship podman WITHOUT a compose provider. Folding this into the
  // install step above meant that on the most common RHEL-family starting point the whole
  // step was skipped ("Podman already installed") and the host was left with no way to run
  // a compose project at all — while `appbay doctor` reported exactly that gap. Docker
  // bundles its provider in docker-compose-plugin, so this only bites the Podman path.
  //
  // ⚠️ Probe the PROVIDER, not the runtime: `podman compose version` is what the deploy
  // path actually calls, and it fails when no provider is installed even though podman is.
  if (runtimeIsPodman) {
    const composeWorks = spawnSync(runtime, ["compose", "version"], { stdio: "pipe" }).status === 0;
    actions.push(composeWorks
      ? { id: "install-compose", label: "Compose provider already present", wouldChange: false, command: [] }
      : {
          id: "install-compose",
          label: "Install compose provider for Podman (dnf)",
          wouldChange: true,
          command: ["dnf", "install", "-y", "podman-compose"],
        });
  } else {
    actions.push({
      id: "install-compose",
      label: "Compose provider ships with docker-compose-plugin",
      wouldChange: false,
      command: [],
    });
  }

  // 2. Enable the runtime's service.
  //
  // Podman is daemonless; what the control plane needs is the ROOTFUL API socket, which is
  // `podman.socket` — not a `podman.service` that does not exist. Enabling the wrong unit
  // would report success and leave nothing listening.
  const runtimeUnit = runtimeIsPodman ? "podman.socket" : "docker";
  if (runtimeWillExist && !serviceEnabled(runtimeUnit)) {
    actions.push({
      id: "enable-runtime",
      label: `Enable + start ${runtimeUnit}`,
      wouldChange: true,
      command: ["systemctl", "enable", "--now", runtimeUnit],
    });
  } else {
    actions.push({
      id: "enable-runtime",
      label: `${runtimeUnit} already enabled`,
      wouldChange: false,
      command: [],
    });
  }

  // 3. ACL tooling — only needed when we will set ACLs (service mode, or
  // operator mode with --group). setfacl comes from the `acl` package.
  const needsAcls = owner === "service" || groups.length > 0;
  if (needsAcls && !commandExists("setfacl")) {
    actions.push({
      id: "install-acl",
      label: "Install acl package (for setfacl)",
      wouldChange: true,
      command: ["dnf", "install", "-y", "acl"],
    });
  } else {
    actions.push({
      id: "install-acl",
      label: "acl package already present (or not needed)",
      wouldChange: false,
      command: [],
    });
  }

  // 4. Service account + group — ONLY in service mode. In operator mode the
  // operator's own user is the owner, so no account is created.
  if (owner === "service") {
    if (!groupExists(serviceUser)) {
      actions.push({
        id: "create-group",
        label: `Create system group ${serviceUser}`,
        wouldChange: true,
        command: ["groupadd", "--system", serviceUser],
      });
    } else {
      actions.push({
        id: "create-group",
        label: `Group ${serviceUser} already exists`,
        wouldChange: false,
        command: [],
      });
    }

    // The service account (D-6: no-login, no home, SYSTEM uid < 1000 so it can
    // never collide with a human — uid 1000 is a real person on the fleet).
    if (!svcWillExist) {
      actions.push({
        id: "create-user",
        label: `Create no-login system service account ${serviceUser} (uid ${serviceUid})`,
        wouldChange: true,
        command: [
          "useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin",
          "--uid", String(serviceUid), "--gid", serviceUser, serviceUser,
        ],
      });
      svcWillExist = true;
    } else {
      actions.push({
        id: "create-user",
        label: `Service account ${serviceUser} already exists`,
        wouldChange: false,
        command: [],
      });
    }

    // Add the service account to the docker group (non-root docker access).
    // Decides against the post-bootstrap state: on a fresh host the account is
    // created above, so this must still run. Idempotent: skips when already a
    // member.
    //
    // ⚠️ THERE IS NO PODMAN EQUIVALENT, and inventing one would be worse than skipping.
    // Docker's group grants access to a root-owned daemon socket; rootful Podman has no
    // long-lived daemon and no `podman` group with those semantics. Adding the account to
    // a group that confers nothing would read, in the output, exactly like access was
    // granted. Say plainly that the step does not apply instead — the rootful access model
    // is the socket unit enabled in step 2.
    if (runtimeIsPodman) {
      actions.push({
        id: "docker-group",
        label: `No group step for rootful Podman (no daemon socket group; see ${runtimeUnit})`,
        wouldChange: false,
        command: [],
      });
    } else if (svcWillExist && dockerWillExist && !userInGroup(serviceUser, "docker")) {
      actions.push({
        id: "docker-group",
        label: `Add ${serviceUser} to docker group`,
        wouldChange: true,
        command: ["usermod", "-aG", "docker", serviceUser],
      });
    } else {
      actions.push({
        id: "docker-group",
        label: `${serviceUser} docker group membership (already set or skipped)`,
        wouldChange: false,
        command: [],
      });
    }
  }

  // 5. Ownership on APPBAY_HOME. In service mode: owned by the service account,
  // setgid group-writable (D-6). In operator mode: owned by the operator.
  if (existsSync(home)) {
    const needsOwner = !dirOwnedBy(home, ownerUser);
    const needsGroup = !dirGroupOwnedBy(home, ownerUser);
    const needsSetgid = owner === "service" && !dirSetgid(home);
    if (needsOwner || needsGroup || needsSetgid) {
      actions.push({
        id: "own-home",
        label: `Set ownership on ${home} to ${ownerUser}:${ownerUser}` +
          (owner === "service" ? " (setgid 2770)" : ""),
        wouldChange: true,
        command: ["chown", "-R", `${ownerUser}:${ownerUser}`, home],
      });
      if (needsSetgid) {
        actions.push({
          id: "setgid-home",
          label: `Set setgid on ${home}`,
          wouldChange: true,
          command: ["chmod", "g+s", home],
        });
      }
    } else {
      actions.push({
        id: "own-home",
        label: `${home} already owned by ${ownerUser}` +
          (owner === "service" ? " (setgid)" : ""),
        wouldChange: false,
        command: [],
      });
    }
  } else {
    actions.push({
      id: "own-home",
      label: `APPBAY_HOME (${home}) does not exist yet — run "appbay init" first`,
      wouldChange: false,
      command: [],
    });
  }

  // 6. ACLs on APPBAY_HOME. Service mode: service account rwx + default,
  // other::--- both normal and default (closes the mode-0644 read leak).
  // Operator mode: only when --group is given, grant that group rwx + default.
  if (existsSync(home) && commandExists("setfacl") && needsAcls) {
    const aclArgs: string[] = ["setfacl", "-R"];
    if (owner === "service") {
      aclArgs.push(
        "-m", `u:${serviceUser}:rwx`,
        "-m", `g:${serviceUser}:rwx`,
        "-m", "o::---",
        "-m", `d:u:${serviceUser}:rwx`,
        "-m", `d:g:${serviceUser}:rwx`,
        "-m", "d:o::---",
      );
    }
    for (const group of groups) {
      aclArgs.push(
        "-m", `g:${group}:rwx`,
        "-m", `d:g:${group}:rwx`,
      );
    }
    aclArgs.push(home);
    actions.push({
      id: "acl-home",
      label: `Set default ACLs on ${home}` +
        (owner === "service" ? ` (${serviceUser}:rwx, other::---)` : "") +
        (groups.length > 0 ? ` + groups ${groups.join(", ")}` : ""),
      wouldChange: true,
      command: aclArgs,
    });
  } else if (existsSync(home) && needsAcls && !commandExists("setfacl")) {
    // setfacl absent even after the install step — ownership was set in step 5,
    // ACLs are skipped. Degraded but functional.
    actions.push({
      id: "acl-home",
      label: `setfacl unavailable — ownership set in step 5, ACLs skipped`,
      wouldChange: false,
      command: [],
    });
  } else {
    actions.push({
      id: "acl-home",
      label: `APPBAY_HOME (${home}) does not exist yet — run "appbay init" first`,
      wouldChange: false,
      command: [],
    });
  }

  // 7. Record the decision in system-level config so `appbay init` (and every
  // other command) resolves the same home + ownership model. Written via sudo
  // because /etc/appbay is root-owned and this process runs as the operator.
  // `mkdir -p` first — the dir does not exist on a fresh host.
  const configContent = [
    `owner: ${owner}`,
    ...(owner === "service" ? [`service_user: ${serviceUser}`] : []),
    `home: ${home}`,
  ].join("\n") + "\n";
  actions.push({
    id: "write-config",
    label: `Record ownership model in ${SYSTEM_CONFIG_FILE}`,
    wouldChange: true,
    command: ["sh", "-c", `mkdir -p ${SYSTEM_CONFIG_DIR} && tee ${SYSTEM_CONFIG_FILE}`],
    // The content is piped to sudo tee by the executor, not passed as argv.
    stdin: configContent,
  });

  return actions;
}

export const initSystemCommand = new Command("init-system")
  .description(
    "Bootstrap a fresh host to run Appbay (RHEL-family): install Docker, set up ownership + access for the appbay tree. --owner service (default) creates a no-login system service account (D-6, homelab/worklab); --owner operator uses your own user (personal). Standalone-host convenience — ansible is authoritative for the DGX fleet.",
  )
  .option("--dry-run", "show what would change without running any sudo command")
  .option("--owner <operator|service>", "who owns the appbay tree (default: service)")
  .option("--service-user <name>", `service account name (default: ${DEFAULT_SERVICE_USER})`)
  .option("--service-uid <n>", `system uid for the service account (default: ${DEFAULT_SERVICE_UID})`, parseInt)
  .option("--group <name>", "grant a group access via default ACLs (repeatable)", collect, [])
  .option("--home <path>", "APPBAY_HOME location (default: ~/appbay for operator, /var/lib/appbay for service)")
  .action((options: {
    dryRun?: boolean;
    owner?: string;
    serviceUser?: string;
    serviceUid?: number;
    group?: string[];
    home?: string;
  }) => {
    const distro = detectDistro();

    console.log("Appbay init-system\n");
    console.log(`  Distro: ${distro.prettyName} (${distro.family})`);

    if (distro.family !== "rhel") {
      console.error(
        `\n  Unsupported distro family "${distro.family}". ` +
          "init-system is RHEL-family-first (matches prod). " +
          "For the DGX fleet, use the ansible substrate instead.",
      );
      process.exit(1);
    }

    const owner = options.owner === "operator" ? "operator" : "service";
    // The appbay tree location. Service mode defaults to a SYSTEM path (not the
    // operator's home — the service account cannot own a path inside a human's
    // home). Operator mode defaults to ~/appbay. An explicit --home wins.
    const home =
      options.home ??
      (owner === "service"
        ? DEFAULT_SERVICE_HOME
        : join(homedir(), ".appbay"));

    const plan = planSystemBootstrap({
      owner,
      serviceUser: options.serviceUser,
      serviceUid: options.serviceUid,
      groups: options.group,
      home,
    });
    const changes = plan.filter((a) => a.wouldChange);

    console.log(`  Owner model: ${owner === "service" ? "service account (D-6)" : "operator's own user"}`);
    console.log(`  APPBAY_HOME: ${home}`);
    console.log("");
    if (changes.length === 0) {
      console.log("  Host is already bootstrapped. Nothing to do.");
      return;
    }

    if (options.dryRun) {
      console.log("  Dry run — would make these changes:\n");
      for (const action of changes) {
        console.log(`  • ${action.label}`);
        console.log(`    sudo ${action.command.join(" ")}`);
      }
      console.log("\n  No changes made.");
      return;
    }

    console.log("  Applying changes:\n");
    for (const action of changes) {
      process.stdout.write(`  • ${action.label} ... `);
      // Actions with `stdin` (the config write) pipe content into the sudo
      // process; everything else runs with no input.
      const result = spawnSync("sudo", action.command, {
        stdio: ["pipe", "pipe", "pipe"],
        input: action.stdin,
      });
      if (result.status === 0) {
        console.log("ok");
      } else {
        const err = result.stderr ? String(result.stderr).trim() : "unknown error";
        console.log("FAILED");
        console.error(`    ${err}`);
        console.error("    Re-run with --dry-run to review, then fix and retry.");
        process.exit(1);
      }
    }

    console.log("\n  Host bootstrap complete.");
    console.log(`  Recorded in ${SYSTEM_CONFIG_FILE}: owner=${owner}, home=${home}`);
    console.log("  Next: run \"appbay init\" to scaffold APPBAY_HOME, then \"appbay setup\".");
  });
