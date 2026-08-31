/**
 * Switch a host between edge stacks without stranding it without an edge.
 *
 * 🚨 WHY THIS EXISTS. Before it, changing `ingress_provider` flipped a key in
 * project.yaml and nothing else. The old proxy kept running and kept holding :80/:443,
 * the new one could not bind, and apps recompiled to configuration the running proxy did
 * not read. Every command reported success. The host was serving stale routes from a
 * proxy the installation no longer believed in.
 *
 * ⚠️ THE EDGE IS THE ONLY PATH TO EVERY DEPLOYED APP. A failed migration is not one
 * broken feature, it is total loss of ingress for the whole host. So the order is:
 * validate the candidate BEFORE stopping anything, keep a backup, and restore on any
 * failure — never "stop, then hope".
 *
 * One host runs exactly one edge (S25 invariant): both bind :80 and :443 and cannot
 * coexist. That is why this is a migration rather than an install.
 */

import { spawnSync } from "node:child_process";
import { cp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { containerBin } from "../runtime/container-runtime.js";
import { APP_LABEL } from "../compiler/identity.js";
import type { IngressProvider } from "../schemas/instance.js";

export interface EdgeMigrationStep {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface EdgeMigrationResult {
  migrated: boolean;
  from: IngressProvider;
  to: IngressProvider;
  steps: EdgeMigrationStep[];
  /** Set when the candidate failed and the previous edge was put back. */
  restored?: boolean;
}

/** Who currently holds a port, described well enough for an operator to act on it. */
export interface PortOwner {
  port: number;
  /** Container name when a container holds it; otherwise a host process description. */
  heldBy: string | null;
  /** True when the holder is the edge we are replacing — expected, not a conflict. */
  isOutgoingEdge: boolean;
}

const EDGE_PORTS = [80, 443] as const;

/**
 * Find out who holds the edge ports BEFORE trying to bind them.
 *
 * ⚠️ A bind failure surfaces as a container that exits immediately, and `compose up -d`
 * reports success for that (it started the container; it does not wait to see it stay up).
 * So an unreported port conflict looks exactly like a healthy deploy followed by an edge
 * that is mysteriously absent. Detect it first and name the holder.
 */
export function inspectEdgePorts(outgoing: IngressProvider, appbayHome?: string): PortOwner[] {
  const runtime = containerBin(appbayHome);
  const owners: PortOwner[] = [];

  // Container holders first: the common case, and the only one we can name precisely.
  //
  // 🚨 LABELS, NOT THE NAME. Identifying the outgoing edge by a `appbay.${outgoing}.` name
  // prefix was wrong the moment §4 landed: both system apps declare `namespace: system`, so
  // the real container is `appbay.system.caddy.caddy` and the prefix never matched. The
  // outgoing edge was therefore reported as a foreign holder of :80/:443 and step 1 of the
  // migration aborted — every `--ingress-provider` switch refused, blaming a conflict with
  // the very edge it was replacing.
  //
  // `identity.ts` already says why a name cannot answer this: `appbay.<app>.<service>` and
  // `appbay.<ns>.<app>` have the same shape, so segment counting cannot disambiguate them
  // either. APP_LABEL exists for exactly this question.
  const ps = spawnSync(runtime, ["ps", "--format", "{{.Names}}\t{{.Ports}}\t{{.Labels}}"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = ps.status === 0 ? String(ps.stdout).trim().split("\n").filter(Boolean) : [];

  for (const port of EDGE_PORTS) {
    let heldBy: string | null = null;
    let isOutgoingEdge = false;
    for (const line of lines) {
      const [name, ports, labels] = line.split("\t");
      // Match `:80->` and `:443->` specifically; `:8080->` must not match `:80`.
      if (name && ports && new RegExp(`:${port}->`).test(ports)) {
        heldBy = name;
        // `{{.Labels}}` is a comma-separated `k=v` list. Match the whole pair so
        // `com.appbay.app=caddy-old` cannot satisfy a search for `caddy`.
        isOutgoingEdge = (labels ?? "")
          .split(",")
          .map((pair) => pair.trim())
          .includes(`${APP_LABEL}=${outgoing}`);
        break;
      }
    }
    owners.push({ port, heldBy, isOutgoingEdge });
  }
  return owners;
}

/**
 * Conflicts that would stop the incoming edge from binding.
 *
 * The outgoing edge holding the ports is NOT a conflict — that is the thing being
 * replaced, and it gets stopped as part of the migration.
 */
export function blockingPortConflicts(owners: PortOwner[]): PortOwner[] {
  return owners.filter((o) => o.heldBy !== null && !o.isOutgoingEdge);
}

/**
 * Migrate from one edge stack to another, restoring the previous one on any failure.
 *
 * ```text
 * ALGORITHM migrate_edge(from, to)
 *   1. inspect :80/:443. A holder that is not `from` aborts BEFORE anything changes.
 *   2. validate the candidate config. Invalid -> abort, nothing stopped.
 *   3. back up the outgoing edge's config directory.
 *   4. stop the outgoing stack.
 *   5. start the candidate.
 *   6. run the mode-specific health check.
 *   7. on any failure in 5-6: stop candidate, restore backup, restart outgoing, report.
 * ```
 *
 * Steps 1 and 2 are deliberately before step 4: everything that can be known without
 * taking the host's ingress down is checked while it is still up.
 */
export async function migrateEdge(opts: {
  appbayHome: string;
  from: IngressProvider;
  to: IngressProvider;
  /** Validate the candidate tree. Returns null when valid, else the reason. */
  validateCandidate: () => Promise<string | null>;
  /** Bring a stack down. */
  stopStack: (provider: IngressProvider) => Promise<void>;
  /** Bring a stack up. */
  startStack: (provider: IngressProvider) => Promise<void>;
  /** Mode-specific liveness check. Returns null when healthy, else the reason. */
  checkHealth: (provider: IngressProvider) => Promise<string | null>;
}): Promise<EdgeMigrationResult> {
  const steps: EdgeMigrationStep[] = [];
  const record = (id: string, label: string, ok: boolean, detail?: string) => {
    steps.push({ id, label, ok, detail });
    return ok;
  };
  const fail = (): EdgeMigrationResult => ({ migrated: false, from: opts.from, to: opts.to, steps });

  if (opts.from === opts.to) {
    record("noop", `Edge is already ${opts.to}`, true);
    return { migrated: false, from: opts.from, to: opts.to, steps };
  }

  // 1. Port ownership — before anything is touched.
  const owners = inspectEdgePorts(opts.from, opts.appbayHome);
  const conflicts = blockingPortConflicts(owners);
  if (conflicts.length > 0) {
    const detail = conflicts
      .map((c) => `:${c.port} is held by ${c.heldBy ?? "an unknown process"}`)
      .join("; ");
    record("ports", "Edge ports are available", false,
      `${detail}. Stop it before migrating — the incoming edge cannot bind, and a bind ` +
      `failure would surface as a container that starts and immediately exits.`);
    return fail();
  }
  record("ports", "Edge ports are available", true,
    owners.every((o) => o.heldBy === null)
      ? "nothing is bound"
      : `held by the outgoing ${opts.from} edge, which this migration stops`);

  // 2. Validate the candidate while the current edge is still serving.
  const invalid = await opts.validateCandidate();
  if (invalid !== null) {
    record("validate", `Candidate ${opts.to} configuration is valid`, false, invalid);
    return fail();
  }
  record("validate", `Candidate ${opts.to} configuration is valid`, true);

  // 3. Back up the outgoing edge's config.
  const outgoingDir = join(opts.appbayHome, "etc", "apps", opts.from);
  const backupDir = `${outgoingDir}.pre-${opts.to}`;
  let backedUp = false;
  try {
    await stat(outgoingDir);
    await rm(backupDir, { recursive: true, force: true });
    await cp(outgoingDir, backupDir, { recursive: true });
    backedUp = true;
    record("backup", `Backed up ${opts.from} configuration`, true, backupDir);
  } catch {
    // No outgoing config is legitimate — a host may never have deployed the old edge.
    record("backup", `Backed up ${opts.from} configuration`, true, "nothing to back up");
  }

  // 4-6. Stop old, start new, check. Any failure rolls back.
  try {
    await opts.stopStack(opts.from);
    record("stop", `Stopped ${opts.from}`, true);

    await opts.startStack(opts.to);
    record("start", `Started ${opts.to}`, true);

    const unhealthy = await opts.checkHealth(opts.to);
    if (unhealthy !== null) throw new Error(unhealthy);
    record("health", `${opts.to} is healthy`, true);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    record("health", `${opts.to} is healthy`, false, reason);

    // 7. Restore. Best-effort by necessity — if this fails the host has no edge, and
    // saying so plainly is the only useful thing left to do.
    const restoreNotes: string[] = [];
    try {
      await opts.stopStack(opts.to);
    } catch (e) {
      restoreNotes.push(`could not stop ${opts.to}: ${String(e)}`);
    }
    if (backedUp) {
      try {
        await rm(outgoingDir, { recursive: true, force: true });
        await cp(backupDir, outgoingDir, { recursive: true });
      } catch (e) {
        restoreNotes.push(`could not restore config: ${String(e)}`);
      }
    }
    try {
      await opts.startStack(opts.from);
    } catch (e) {
      restoreNotes.push(`could not restart ${opts.from}: ${String(e)}`);
    }

    const restored = restoreNotes.length === 0;
    record("restore", `Restored ${opts.from}`, restored,
      restored
        ? `${opts.from} is serving again; ${opts.to} was not adopted`
        : `🚨 THIS HOST MAY HAVE NO EDGE. ${restoreNotes.join("; ")}`);

    return { migrated: false, from: opts.from, to: opts.to, steps, restored };
  }

  return { migrated: true, from: opts.from, to: opts.to, steps };
}
