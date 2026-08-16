/**
 * Unit tests for the shared checks module (`utils/checks.ts`).
 *
 * The check functions themselves spawn real container commands, so they are
 * exercised end-to-end on a live host rather than in unit tests. What is unit-
 * tested here is the deterministic surface both `doctor` and `init` depend on:
 * the required-failure filter, the human formatter, the remediation block, and
 * the shape of the init preflight gate.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compareSemver } from "../exec.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requiredChecksFailed,
  formatCheck,
  formatRemediation,
  buildDoctorJson,
  checkHealthcheckStartPeriod,
  runInitPreflight,
  type CheckResult,
  parseComposeProvider,
  COMPOSE_PROVIDER_MINIMUMS,
} from "../checks.js";

function check(overrides: Partial<CheckResult>): CheckResult {
  return {
    name: "test",
    passed: true,
    detail: "ok",
    required: true,
    ...overrides,
  };
}

describe("requiredChecksFailed", () => {
  it("returns only required checks that failed", () => {
    const checks: CheckResult[] = [
      check({ name: "a", passed: true, required: true }),
      check({ name: "b", passed: false, required: true }),
      check({ name: "c", passed: false, required: false }),
      check({ name: "d", passed: true, required: false }),
    ];
    const failed = requiredChecksFailed(checks);
    expect(failed.map((c) => c.name)).toEqual(["b"]);
  });

  it("returns empty when all required checks pass", () => {
    const checks: CheckResult[] = [
      check({ name: "a", passed: true, required: true }),
      check({ name: "b", passed: false, required: false }),
    ];
    expect(requiredChecksFailed(checks)).toEqual([]);
  });
});

describe("formatCheck", () => {
  it("marks a passed check with a checkmark and no fix", () => {
    const out = formatCheck(check({ name: "Docker", passed: true, detail: "v24" }));
    expect(out).toContain("✓ Docker");
    expect(out).toContain("v24");
    expect(out).not.toContain("Fix:");
  });

  it("marks a failed required check with a cross and its fix", () => {
    const out = formatCheck(
      check({ name: "Docker", passed: false, detail: "not found", fix: "Install Docker" }),
    );
    expect(out).toContain("✗ Docker");
    expect(out).toContain("not found");
    expect(out).toContain("Fix: Install Docker");
  });

  it("labels optional checks", () => {
    const out = formatCheck(check({ name: "GPU", passed: false, required: false }));
    expect(out).toContain("(optional)");
  });
});

describe("formatRemediation", () => {
  it("returns empty string when nothing failed", () => {
    expect(formatRemediation([check({ passed: true }), check({ passed: true })])).toBe("");
  });

  it("groups required failures under a Required heading", () => {
    const out = formatRemediation([
      check({ name: "Docker", passed: false, required: true, fix: "Install Docker" }),
      check({ name: "GPU", passed: true }),
    ]);
    expect(out).toContain("Required fixes:");
    expect(out).toContain("Docker: Install Docker");
    expect(out).not.toContain("Optional");
  });

  it("groups optional failures under an Optional heading", () => {
    const out = formatRemediation([
      check({ name: "GPU", passed: false, required: false, fix: "Install drivers" }),
      check({ name: "Docker", passed: true }),
    ]);
    expect(out).toContain("Optional (recommended):");
    expect(out).toContain("GPU: Install drivers");
    expect(out).not.toContain("Required fixes:");
  });

  it("lists both groups when both kinds fail", () => {
    const out = formatRemediation([
      check({ name: "Docker", passed: false, required: true, fix: "Install Docker" }),
      check({ name: "GPU", passed: false, required: false, fix: "Install drivers" }),
    ]);
    expect(out).toContain("Required fixes:");
    expect(out).toContain("Optional (recommended):");
  });
});

describe("runInitPreflight", () => {
  it("returns exactly the four environment-level required checks", async () => {
    const checks = await runInitPreflight();
    expect(checks).toHaveLength(4);
    // Every preflight check must be required — an optional check has no business
    // gating init.
    for (const c of checks) {
      expect(c.required).toBe(true);
    }
    // The names are the environment checks, NOT the APPBAY_HOME or network
    // checks that init itself creates.
    const names = checks.map((c) => c.name);
    expect(names).toContain("Docker");
    expect(names).toContain("Docker service");
    expect(names).toContain("Docker Compose v2");
    // ⚠️ The version check now NAMES THE PROVIDER it is holding to a minimum
    // ("docker-compose >= 2.23.1", "podman-compose >= 1.5.0") rather than saying a bare
    // "Compose >= 2.23.1" that was only ever true for Docker. Match the shape, not one
    // literal, so this test does not have to change again per provider.
    expect(names.some((n) => /^(docker|podman)-compose >= \d/.test(n))).toBe(true);
  });
});

describe("buildDoctorJson", () => {
  it("produces the flat {ok, checks[]} envelope", () => {
    const checks: CheckResult[] = [
      check({ name: "Docker", passed: true, detail: "v24", required: true }),
      check({ name: "GPU", passed: false, detail: "no gpu", fix: "install", required: false }),
    ];
    const payload = buildDoctorJson(checks);
    expect(payload.ok).toBe(true);
    expect(payload.checks).toHaveLength(2);
    expect(payload.checks[0]).toEqual({
      name: "Docker",
      passed: true,
      detail: "v24",
      fix: undefined,
      required: true,
    });
    expect(payload.checks[1]).toEqual({
      name: "GPU",
      passed: false,
      detail: "no gpu",
      fix: "install",
      required: false,
    });
  });

  it("sets ok=false when any required check fails", () => {
    const checks: CheckResult[] = [
      check({ name: "Docker", passed: true, required: true }),
      check({ name: "Compose", passed: false, required: true }),
    ];
    expect(buildDoctorJson(checks).ok).toBe(false);
  });

  it("keeps ok=true when only optional checks fail", () => {
    const checks: CheckResult[] = [
      check({ name: "Docker", passed: true, required: true }),
      check({ name: "GPU", passed: false, required: false }),
    ];
    expect(buildDoctorJson(checks).ok).toBe(true);
  });
});

describe("checkHealthcheckStartPeriod", () => {
  let home: string;

  beforeEach(() => {
    home = join(tmpdir(), `appbay-hc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.APPBAY_HOME = home;
  });

  afterEach(() => {
    delete process.env.APPBAY_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("passes when no known-slow app has a rendered compose", () => {
    const result = checkHealthcheckStartPeriod();
    expect(result.passed).toBe(true);
    expect(result.required).toBe(false);
  });

  it("passes when a known-slow app has an adequate start_period", () => {
    const dir = join(home, "var", "lib", "renders", "ollama");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "docker-compose.rendered.yml"),
      "services:\n  ollama:\n    healthcheck:\n      start_period: 120s\n",
      "utf-8",
    );
    const result = checkHealthcheckStartPeriod();
    expect(result.passed).toBe(true);
  });

  it("fails when a known-slow app has an undersized start_period", () => {
    const dir = join(home, "var", "lib", "renders", "ollama");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "docker-compose.rendered.yml"),
      "services:\n  ollama:\n    healthcheck:\n      start_period: 10s\n",
      "utf-8",
    );
    const result = checkHealthcheckStartPeriod();
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("ollama");
    expect(result.fix).toBeTruthy();
  });
});

/**
 * 🚨 THE REGRESSION: `appbay doctor` failed a REQUIRED check on a working host.
 *
 * The compose version check assumed one universal minimum — Docker Compose's 2.23.1 — and
 * compared podman-compose's independent 1.x line against it:
 *     ✗ Compose >= 2.23.1
 *       v1.5.0 (too old)
 * podman-compose will never reach 2.x, so on RHEL-family hosts (the runtime target S23
 * designates for Podman) that check could never pass. Measured on Fedora 43: rootful podman
 * 5.6.2 + podman-compose 1.5.0 runs `compose up -d` and produces a live container.
 *
 * The parse is the part that was wrong, and it is pure, so it is what is tested here. The
 * checks themselves spawn real container commands and stay end-to-end, per this file's header.
 */
describe("parseComposeProvider", () => {
  // Podman prints its OWN version first, then the provider's. A naive "first version wins"
  // parse picks up the runtime version (5.6.2) and compares that to a compose minimum.
  const PODMAN_OUTPUT = [
    ">>>> Executing external compose provider \"/usr/bin/podman-compose\". <<<<",
    "",
    "podman version 5.6.2",
    "podman-compose version 1.5.0",
  ].join("\n");

  it("reads the PROVIDER version, not the runtime version that precedes it", () => {
    const provider = parseComposeProvider(PODMAN_OUTPUT);
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe("podman-compose");
    expect(provider?.version).toBe("1.5.0");
  });

  it("holds podman-compose to its own minimum, never Docker Compose's", () => {
    const provider = parseComposeProvider(PODMAN_OUTPUT);
    // The exact regression: 1.5.0 vs 2.23.1 marked a working host as too old.
    expect(provider?.minimum).toBe(COMPOSE_PROVIDER_MINIMUMS["podman-compose"]);
    expect(provider?.minimum).not.toBe(COMPOSE_PROVIDER_MINIMUMS["docker-compose"]);
    expect(compareSemver(provider!.version, provider!.minimum)).toBeGreaterThanOrEqual(0);
  });

  it("identifies docker compose and holds it to 2.23.1", () => {
    const provider = parseComposeProvider("Docker Compose version v2.29.7");
    expect(provider?.name).toBe("docker-compose");
    expect(provider?.version).toBe("2.29.7");
    expect(provider?.minimum).toBe("2.23.1");
  });

  // A genuinely old provider must still be caught — this must not become a check that
  // always passes, which would be a worse bug than the one it replaced.
  it("still fails a provider that is actually too old", () => {
    const provider = parseComposeProvider("Docker Compose version v2.10.0");
    expect(compareSemver(provider!.version, provider!.minimum)).toBeLessThan(0);
  });

  it("returns null when no provider line is present, so the caller can fall back", () => {
    expect(parseComposeProvider("")).toBeNull();
    expect(parseComposeProvider("some unrelated banner")).toBeNull();
  });
});
