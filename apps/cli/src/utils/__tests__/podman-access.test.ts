/**
 * The two files that grant a service account the rootful Podman socket — RFC-001 S34.
 *
 * ⭐ EVERY ASSERTION HERE IS A MEASURED FAILURE MODE FROM probe-89, not a format check. Each of
 * these files is accepted by systemd in shapes that then grant nothing, or that break something
 * else while appearing to work.
 */

import { describe, expect, it } from "vitest";
import {
  PODMAN_SOCKET_DROPIN,
  PODMAN_TMPFILES_OVERRIDE,
  renderPodmanSocketDropin,
  renderPodmanTmpfilesOverride,
} from "../podman-access.js";

describe("the socket drop-in", () => {
  it("sets SocketGroup to the service account", () => {
    expect(renderPodmanSocketDropin("appbay")).toContain("SocketGroup=appbay");
  });

  it("restates SocketMode rather than inheriting it", () => {
    // Fedora's podman.socket already sets 0660. Restating it means the grant does not depend
    // on a default a distro or a future podman release could change underneath us.
    expect(renderPodmanSocketDropin("appbay")).toContain("SocketMode=0660");
  });

  it("is a [Socket] section — a [Service] drop-in on a .socket unit is silently inert", () => {
    expect(renderPodmanSocketDropin("appbay")).toContain("[Socket]");
  });

  it("🚨 does NOT rely on DirectoryMode", () => {
    // It was in the first version and did nothing: DirectoryMode applies only when systemd
    // CREATES the parent, and /usr/lib/tmpfiles.d/podman.conf created /run/podman first. The
    // socket came out root:appbay 0660 and the account still got `connect: permission denied`.
    // The directory is the other file's job; asserting its absence here keeps the two from
    // being confused for one mechanism again.
    expect(renderPodmanSocketDropin("appbay")).not.toContain("DirectoryMode");
  });

  it("lands in a .d directory so podman's own unit is untouched", () => {
    expect(PODMAN_SOCKET_DROPIN).toMatch(/podman\.socket\.d\/.*\.conf$/);
  });
});

describe("the tmpfiles override", () => {
  it("adjusts /run/podman to 0750 root:<service account>", () => {
    expect(renderPodmanTmpfilesOverride("appbay")).toMatch(
      /^z \/run\/podman 0750 root appbay -$/m,
    );
  });

  it("uses `z`, not `d` — the directory already exists", () => {
    // `d` creates-if-absent and would not adjust the 0700 root root that podman's own tmpfiles
    // already put there. `z` adjusts an existing path.
    const body = renderPodmanTmpfilesOverride("appbay");
    expect(body).not.toMatch(/^[dD]!? \/run\/podman/m);
  });

  it("🚨 is NOT named podman.conf", () => {
    // systemd-tmpfiles takes at most one file per BASENAME across its search path, /etc
    // winning. `/etc/tmpfiles.d/podman.conf` would shadow /usr/lib's entirely and silently
    // drop its other lines — the /tmp/podman-run-* and /var/tmp/container_images* cleanup.
    expect(PODMAN_TMPFILES_OVERRIDE).not.toMatch(/\/podman\.conf$/);
  });

  it("🚨 sorts AFTER podman.conf", () => {
    // Files are applied in lexicographic order by filename regardless of directory. A name
    // sorting before `podman.conf` would be overwritten by podman's own `D! ... 0700 root root`
    // at every boot, so the grant would work until the first reboot and then quietly stop.
    const basename = PODMAN_TMPFILES_OVERRIDE.split("/").pop()!;
    expect(basename.localeCompare("podman.conf")).toBeGreaterThan(0);
  });
});

describe("both files", () => {
  it("say they are generated, so an operator does not hand-edit them", () => {
    for (const body of [renderPodmanSocketDropin("appbay"), renderPodmanTmpfilesOverride("appbay")]) {
      expect(body).toMatch(/appbay init-system/);
    }
  });

  it("use the account they are given, never a hardcoded name", () => {
    // `--service-user` is a documented flag; a hardcoded `appbay` would grant the socket to an
    // account that does not run anything.
    for (const body of [renderPodmanSocketDropin("llmsvc"), renderPodmanTmpfilesOverride("llmsvc")]) {
      expect(body).toContain("llmsvc");
      expect(body).not.toMatch(/\bappbay\b(?!\s+init-system)/);
    }
  });
});
