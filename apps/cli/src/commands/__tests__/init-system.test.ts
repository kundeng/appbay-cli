/**
 * Unit tests for the `init-system` command's plan logic.
 *
 * The plan functions read real host state (docker present, user present,
 * systemd units), so the pass/fail of individual actions is environment-
 * dependent. What is deterministic and worth asserting is the plan's shape:
 * the action ids, their order, and that each carries a label and a command
 * array. The D-6 model invariants (no-login system service account, default
 * ACLs with other::---) are also asserted from the command strings.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  planSystemBootstrap,
  initSystemCommand,
  DEFAULT_SERVICE_USER,
  DEFAULT_SERVICE_UID,
} from "../init-system.js";

// A real APPBAY_HOME so the ownership/ACL actions produce real commands.
let home: string;
beforeEach(() => {
  home = join(tmpdir(), `appbay-init-sys-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  process.env.APPBAY_HOME = home;
});
afterEach(() => {
  delete process.env.APPBAY_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("planSystemBootstrap", () => {
  it("returns the bootstrap actions in a stable order", () => {
    const plan = planSystemBootstrap();
    expect(plan.map((a) => a.id)).toEqual([
      // Renamed from install-docker/enable-docker: the step installs whatever runtime the
      // install is CONFIGURED for (S23), not Docker unconditionally. On a Podman install it
      // installs podman + a compose provider and enables podman.socket.
      "install-runtime",
      "install-compose",
      "enable-runtime",
      "install-acl",
      "create-group",
      "create-user",
      "docker-group",
      "own-home",
      "setgid-home",
      "acl-home",
      "write-config",
    ]);
  });

  it("gives every action a label and a command array", () => {
    for (const action of planSystemBootstrap()) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(Array.isArray(action.command)).toBe(true);
    }
  });

  it("marks a no-change action with an empty command", () => {
    // At least one action is a no-op on any host (e.g. docker already present,
    // or APPBAY_HOME absent). The plan must represent that as wouldChange=false
    // with an empty command so a dry-run never prints a sudo line for it.
    const plan = planSystemBootstrap();
    for (const action of plan) {
      if (!action.wouldChange) {
        expect(action.command).toEqual([]);
      }
    }
  });

  it("creates the service account as a no-login SYSTEM account (D-6)", () => {
    const plan = planSystemBootstrap();
    const createUser = plan.find((a) => a.id === "create-user");
    // The command must carry the D-6 flags: --system, --no-create-home,
    // nologin shell, and a system uid (<1000, never a human's).
    expect(createUser?.command).toContain("--system");
    expect(createUser?.command).toContain("--no-create-home");
    expect(createUser?.command).toContain("/usr/sbin/nologin");
    expect(createUser?.command).toContain("--uid");
    const uidIdx = createUser!.command.indexOf("--uid");
    const uid = Number(createUser!.command[uidIdx + 1]);
    expect(uid).toBe(DEFAULT_SERVICE_UID);
    expect(uid).toBeLessThan(1000);
  });

  it("sets default ACLs with other::--- to close the mode-0644 read leak (D-6)", () => {
    const plan = planSystemBootstrap();
    const acl = plan.find((a) => a.id === "acl-home");
    if (acl?.wouldChange) {
      const cmd = acl.command.join(" ");
      // Service account rwx, both normal and default.
      expect(cmd).toContain(`u:${DEFAULT_SERVICE_USER}:rwx`);
      expect(cmd).toContain(`d:u:${DEFAULT_SERVICE_USER}:rwx`);
      // other::--- both normal and default — the non-optional part.
      expect(cmd).toContain("o::---");
      expect(cmd).toContain("d:o::---");
    }
  });

  it("honours a custom service user and uid", () => {
    const plan = planSystemBootstrap({ serviceUser: "llmsvc", serviceUid: 950 });
    const createUser = plan.find((a) => a.id === "create-user");
    expect(createUser?.command).toContain("llmsvc");
    expect(createUser?.command).toContain("950");
  });

  it("operator mode creates no service account and owns the tree as the operator", () => {
    const plan = planSystemBootstrap({ owner: "operator" });
    const ids = plan.map((a) => a.id);
    // No service-account steps in operator mode.
    expect(ids).not.toContain("create-user");
    expect(ids).not.toContain("create-group");
    expect(ids).not.toContain("docker-group");
    // Ownership targets the operator's own user, not a service account.
    // ⚠️ Assert the LABEL, not the command. In operator mode `ownerUser` is the
    // invoking user, and APPBAY_HOME was just created by this test's beforeEach —
    // so it is ALREADY owned correctly and `own-home` emits `command: []`. That
    // is the right behaviour (don't chown what is already correct), and it means
    // the command is only present on hosts that happen to need the fix. The label
    // names the owner in every branch, so it is what is invariant.
    const own = plan.find((a) => a.id === "own-home");
    expect(own?.label).toContain(process.env.USER ?? "root");
    if (own?.wouldChange) {
      expect(own.command.join(" ")).toContain(process.env.USER ?? "root");
    }
  });

  it("operator mode with --group grants that group access via ACLs", () => {
    const plan = planSystemBootstrap({ owner: "operator", groups: ["homelab"] });
    const acl = plan.find((a) => a.id === "acl-home");
    if (acl?.wouldChange) {
      const cmd = acl.command.join(" ");
      expect(cmd).toContain("g:homelab:rwx");
      expect(cmd).toContain("d:g:homelab:rwx");
    }
  });

  it("service mode with --group adds the team group to the D-6 ACLs", () => {
    const plan = planSystemBootstrap({ owner: "service", groups: ["homelab"] });
    const acl = plan.find((a) => a.id === "acl-home");
    if (acl?.wouldChange) {
      const cmd = acl.command.join(" ");
      // D-6 service-account entries still present.
      expect(cmd).toContain(`u:${DEFAULT_SERVICE_USER}:rwx`);
      expect(cmd).toContain("o::---");
      // Plus the team group.
      expect(cmd).toContain("g:homelab:rwx");
      expect(cmd).toContain("d:g:homelab:rwx");
    }
  });

  it("service mode defaults the home to a SYSTEM path, not the operator's home", () => {
    // Use a temp path standing in for the system home (the real /var/lib/appbay
    // is not writable in tests). Create it so the ownership action produces a
    // real command.
    const sysHome = join(tmpdir(), `appbay-syshome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(sysHome, { recursive: true });
    try {
      const plan = planSystemBootstrap({ owner: "service", home: sysHome });
      const own = plan.find((a) => a.id === "own-home");
      expect(own?.command.join(" ")).toContain(sysHome);
      const acl = plan.find((a) => a.id === "acl-home");
      if (acl?.wouldChange) {
        expect(acl.command.join(" ")).toContain(sysHome);
      }
    } finally {
      rmSync(sysHome, { recursive: true, force: true });
    }
  });

  it("operator mode defaults the home to the operator's ~/.appbay", () => {
    // 🚨 NEVER point this at the real $HOME/.appbay. That is the DEFAULT
    // APPBAY_HOME, and the cleanup below is a recursive force-delete: on any
    // box where `appbay init` has run without --dir, running the test suite
    // would destroy the operator's whole installation — apps, renders, state
    // and vault.enc. A temp directory whose basename is `.appbay` proves the
    // same thing and owns everything it deletes.
    const opHome = join(
      tmpdir(),
      `appbay-ophome-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ".appbay",
    );
    mkdirSync(opHome, { recursive: true });
    try {
      const plan = planSystemBootstrap({ owner: "operator", home: opHome });
      const own = plan.find((a) => a.id === "own-home");
      // ⚠️ Assert the LABEL, not the command. `own-home` emits a chown only
      // when ownership actually needs changing; a tree the operator already
      // owns correctly yields `command: []`, which is the right behaviour and
      // is exactly the case operator mode hits. The label names the target
      // path in every branch, so it is what is invariant across hosts.
      expect(own?.label).toContain(".appbay");
      if (own?.wouldChange) {
        expect(own.command.join(" ")).toContain(".appbay");
      }
    } finally {
      rmSync(dirname(opHome), { recursive: true, force: true });
    }
  });
});

describe("initSystemCommand", () => {
  it("is registered with --dry-run, --owner, --service-user, --service-uid and --group options", () => {
    expect(initSystemCommand.name()).toBe("init-system");
    const opts = initSystemCommand.options.map((o) => o.long);
    expect(opts).toContain("--dry-run");
    expect(opts).toContain("--owner");
    expect(opts).toContain("--service-user");
    expect(opts).toContain("--service-uid");
    expect(opts).toContain("--group");
  });
});
