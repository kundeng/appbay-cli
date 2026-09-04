/**
 * The environment a NON-ROOT account needs to reach ROOTFUL podman — RFC-001 S34.
 *
 * ⭐ WHY THIS IS A MODULE AND NOT TWO STRING LITERALS. Three things must agree about how the
 * control plane reaches podman: the systemd unit that runs it, the `doctor` check that predicts
 * whether it can, and this file. When they disagree, nothing errors — the checker exercises a
 * different code path from the runner and reports confidently about a question nobody asked.
 * That already happened once here: `defaultProbeAs` ran `sudo -n -u appbay podman info` with an
 * empty environment, which is the ROOTLESS path, while the unit uses the rootful socket.
 *
 * ⭐ THE NON-OBVIOUS PART IS `CONTAINER_HOST`. `podman` invoked by a non-root user defaults to
 * ROOTLESS, so granting the account membership on the rootful socket's group changes nothing it
 * can do until something points it at that socket. Measured in probe-89: with the socket at
 * `root:appbay 0660` and no CONTAINER_HOST, podman still went rootless and failed on absent
 * subuid ranges — while `ls -l` showed a correctly granted socket. An implementation that
 * shipped the grant alone would have looked finished and worked no better than before.
 *
 * ⚠️ Scope: podman + `--owner service` ONLY. An operator install runs as a user whose rootless
 * podman works, and forcing it onto the rootful socket would break a setup that is fine.
 */

/** The rootful podman API socket. Not `podman.service` — podman is daemonless. */
export const PODMAN_ROOTFUL_SOCKET = "/run/podman/podman.sock";

/** Directory holding the socket. Created `0700 root root` by podman's own tmpfiles.d. */
export const PODMAN_ROOTFUL_SOCKET_DIR = "/run/podman";

/**
 * Environment additions for running podman as the service account.
 *
 * `HOME` is here because the D-6 account is created `--no-create-home`, so the `/home/<user>`
 * in its passwd entry does not exist — and podman fails on that BEFORE it considers a
 * connection, which defeats the rootful path too, not just rootless (probe-88). systemd sets
 * `HOME` from the passwd entry under `User=`, so the unit must override it explicitly.
 *
 * @param home - The APPBAY_HOME the account owns; used as its `$HOME`.
 */
export function podmanRootfulEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    CONTAINER_HOST: `unix://${PODMAN_ROOTFUL_SOCKET}`,
  };
}
