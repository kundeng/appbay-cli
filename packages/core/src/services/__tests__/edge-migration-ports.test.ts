/**
 * Who holds :80 and :443 — `inspectEdgePorts` / `blockingPortConflicts`.
 *
 * ⭐ WHY THESE TWO FUNCTIONS DESERVE TESTS MORE THAN THE MIGRATION AROUND THEM. They are the
 * only thing standing between "replace the edge" and "take the host's entire ingress down and
 * fail to bring it back". The module's own header says a bind failure surfaces as a container
 * that exits immediately, and `compose up -d` reports SUCCESS for that — it started the
 * container, it does not wait to see it stay up. So a missed conflict looks exactly like a
 * healthy deploy followed by an edge that is mysteriously absent.
 *
 * Two ways to be wrong, opposite costs:
 *   - miss a real holder  → the migration proceeds, the new edge cannot bind, ingress is gone
 *   - flag the outgoing edge → the migration refuses to run at all, forever
 *
 * The `:${port}->` matcher carries a documented hazard — ":8080->" must not read as port 80 —
 * that had no test. That is the kind of comment which is true until somebody "simplifies" it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { blockingPortConflicts, inspectEdgePorts } from "../edge-migration-service.js";

const mockedSpawn = vi.mocked(spawnSync);

/** `docker ps --format "{{.Names}}\t{{.Ports}}"` output. */
function ps(...lines: string[]) {
  mockedSpawn.mockReturnValue({
    status: 0,
    stdout: lines.join("\n"),
    stderr: "",
    error: undefined,
  } as never);
}

beforeEach(() => {
  process.env.APPBAY_CONTAINER_RUNTIME = "docker";
  mockedSpawn.mockReset();
});

afterEach(() => {
  delete process.env.APPBAY_CONTAINER_RUNTIME;
});

describe("finding the holder", () => {
  it("names the container holding each edge port", () => {
    ps("appbay.caddy.caddy\t0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp");
    const owners = inspectEdgePorts("traefik");
    expect(owners.map((o) => [o.port, o.heldBy])).toEqual([
      [80, "appbay.caddy.caddy"],
      [443, "appbay.caddy.caddy"],
    ]);
  });

  it("reports a free port as unheld rather than guessing", () => {
    ps("appbay.caddy.caddy\t0.0.0.0:80->80/tcp");
    const owners = inspectEdgePorts("traefik");
    expect(owners.find((o) => o.port === 443)?.heldBy).toBeNull();
  });

  it("survives the runtime failing entirely — no holder, not a crash", () => {
    // `docker ps` failing is not evidence that the ports are free, but it is also not a
    // reason to throw inside a pre-flight check. It reports nothing held; step 2's config
    // validation and the bind itself still stand behind it.
    mockedSpawn.mockReturnValue({ status: 1, stdout: "", stderr: "no daemon", error: undefined } as never);
    expect(inspectEdgePorts("traefik").every((o) => o.heldBy === null)).toBe(true);
  });
});

describe("🚨 the port matcher", () => {
  it("does not read :8080 as :80", () => {
    // The documented hazard. A dev container on 8080 must not look like it holds the edge
    // port — that would refuse every migration on a host that has one.
    ps("some-dev-thing\t0.0.0.0:8080->80/tcp");
    expect(inspectEdgePorts("traefik").find((o) => o.port === 80)?.heldBy).toBeNull();
  });

  it("does not read :180 or :8443 as :80 or :443 either", () => {
    ps("a\t0.0.0.0:180->80/tcp", "b\t0.0.0.0:8443->443/tcp");
    expect(inspectEdgePorts("traefik").every((o) => o.heldBy === null)).toBe(true);
  });

  it("matches the HOST port, not the container port", () => {
    // `0.0.0.0:9000->80/tcp` publishes 9000 on the host. The edge needs host :80.
    ps("x\t0.0.0.0:9000->80/tcp");
    expect(inspectEdgePorts("traefik").find((o) => o.port === 80)?.heldBy).toBeNull();
  });

  it("still matches when the port list has an IPv6 entry alongside", () => {
    ps("appbay.caddy.caddy\t0.0.0.0:80->80/tcp, :::80->80/tcp");
    expect(inspectEdgePorts("traefik").find((o) => o.port === 80)?.heldBy).toBe("appbay.caddy.caddy");
  });
});

describe("🚨 telling the outgoing edge apart from a real conflict", () => {
  it("the edge being replaced is NOT a conflict", () => {
    // It is the thing being stopped. Flagging it would make every migration impossible.
    ps("appbay.traefik.traefik\t0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp");
    const owners = inspectEdgePorts("traefik");
    expect(owners.every((o) => o.isOutgoingEdge)).toBe(true);
    expect(blockingPortConflicts(owners)).toEqual([]);
  });

  it("🚨 the OTHER edge holding the ports IS a conflict", () => {
    // Migrating traefik -> caddy while caddy already holds :80 means something is already
    // there that this migration did not put there.
    ps("appbay.caddy.caddy\t0.0.0.0:80->80/tcp");
    const blocking = blockingPortConflicts(inspectEdgePorts("traefik"));
    expect(blocking.map((o) => o.port)).toEqual([80]);
    expect(blocking[0]?.heldBy).toBe("appbay.caddy.caddy");
  });

  it("an unrelated container is a conflict", () => {
    ps("nginx-from-last-year\t0.0.0.0:443->443/tcp");
    const blocking = blockingPortConflicts(inspectEdgePorts("caddy"));
    expect(blocking.map((o) => o.heldBy)).toEqual(["nginx-from-last-year"]);
  });

  it("a name that merely starts with the same letters is a conflict, not the edge", () => {
    // `appbay.traefik.` with the trailing dot is what makes this safe. Without it,
    // `appbay.traefik-old` would be waved through as "the edge we are replacing".
    ps("appbay.traefik-old\t0.0.0.0:80->80/tcp");
    const owners = inspectEdgePorts("traefik");
    expect(owners.find((o) => o.port === 80)?.isOutgoingEdge).toBe(false);
    expect(blockingPortConflicts(owners)).toHaveLength(1);
  });

  it("nothing held is nothing blocking", () => {
    ps();
    expect(blockingPortConflicts(inspectEdgePorts("traefik"))).toEqual([]);
  });
});
