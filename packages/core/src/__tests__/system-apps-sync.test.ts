/**
 * system-apps.ts must be current with respect to system-apps/, and no system app may
 * declare a dependency it does not define.
 *
 * ⭐ THIS FILE REPLACED A BYTE-COMPARISON TEST, and the replacement is smaller because the
 * generator now makes most of it unnecessary. Previously `system-apps/` and
 * `packages/core/src/system-apps.ts` were two hand-maintained copies with nothing between
 * them; a test comparing them file-by-file was the only thing holding them together, and
 * it was added after they had already drifted to 8 differing files with 2 apps existing
 * only as embedded strings.
 *
 * Now the directory is authored and the .ts is generated from it
 * (scripts/generate-system-apps.mjs), so "do they agree" collapses into one question: is
 * the committed generated file what the generator would produce right now?
 *
 * ⚠️ The generated file is COMMITTED rather than built on demand, because `appbay init`
 * seeds from the compiled binary and a bun-compiled binary cannot read the source tree.
 * That is exactly why a staleness check is still needed: a committed artifact can be
 * out of date in a way a build-time-only artifact cannot.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_APPS } from "../system-apps.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("system-apps.ts is generated and current", () => {
  it("matches what scripts/generate-system-apps.mjs would produce", () => {
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "generate-system-apps.mjs"), "--check"],
      { encoding: "utf-8", cwd: REPO_ROOT },
    );

    expect(
      result.status,
      `system-apps.ts is stale. system-apps/ is the source of truth and this file is\n` +
        `generated from it — regenerate and commit both:\n` +
        `    node scripts/generate-system-apps.mjs\n\n` +
        `${result.stderr ?? ""}${result.stdout ?? ""}`,
    ).toBe(0);
  });

  it("ships at least the platform apps", () => {
    // A generator that silently emitted nothing would make the check above pass against an
    // empty file. Guard the floor.
    const names = SYSTEM_APPS.map((a) => a.name);
    for (const required of ["traefik", "caddy"]) {
      expect(names, `${required} missing from SYSTEM_APPS`).toContain(required);
    }
    expect(SYSTEM_APPS.length).toBeGreaterThanOrEqual(10);
  });
});

describe("system app compose sanity", () => {
  it("no app depends_on a service its own compose file does not define", () => {
    // 🚨 NOT A STYLE CHECK. Compose does not skip a dangling dependency — it REJECTS THE
    // WHOLE PROJECT:
    //     service "traefik" depends on undefined service "socket-proxy": invalid compose
    //     project                                                                 (rc=1)
    // That shipped: bd33800 removed the socket-proxy app and left the reference in
    // traefik, so the DEFAULT INGRESS could not deploy, and nothing caught it because the
    // only test naming socket-proxy was broken by the same commit.
    //
    // ⚠️ Kept even though the generator now guarantees the two copies agree — agreement
    // says nothing about whether the content is valid. Two identical copies of a broken
    // compose file are still broken.
    for (const app of SYSTEM_APPS) {
      const raw = app.files["docker-compose.yml"];
      if (!raw) continue;
      const defined = [...raw.matchAll(/^ {2}([a-z0-9][a-z0-9_-]*):/gim)].map((m) => m[1]!);
      const deps = [...raw.matchAll(/depends_on:\s*\n((?:\s*-\s*\S+\n?)+)/gi)].flatMap((m) =>
        [...m[1]!.matchAll(/-\s*(\S+)/g)].map((d) => d[1]!),
      );
      for (const dep of deps) {
        expect(
          defined.includes(dep),
          `${app.name}: depends_on "${dep}" is not a service in its own compose file — ` +
            `compose rejects the ENTIRE project, it does not skip the service`,
        ).toBe(true);
      }
    }
  });
});
