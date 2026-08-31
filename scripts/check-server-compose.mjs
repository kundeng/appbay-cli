#!/usr/bin/env node
/**
 * Fail when the build harness stands up a control plane no installation runs.
 *
 * 🚨 THIS EXISTS BECAUSE THE TWO COPIES ALREADY DIVERGED FOR TWO SPRINTS AND NOTHING NOTICED.
 * `docker-compose.server.yml` at the repo root is what `scripts/build-server.sh` and
 * `scripts/test-compose-deploy.sh` build and smoke-test. It is NOT what an install runs:
 * `appbay init` writes its own copy from an embedded template. That file's own header records
 * the last incident — it described a `socket-proxy` service deleted in S19, so the repository
 * smoke-tested a topology no installation had run since — and names the cause:
 *
 *     "nothing failed, because the two copies are never compared"
 *
 * This is the comparison. It found a second one on its first run: the embedded template
 * hardcoded `3000:3000` while the harness honoured `${APPBAY_PORT}`, so the port was
 * configurable in CI and fixed on every real install.
 *
 * ⚠️ RUNS THE BINARY, DOES NOT READ THE SOURCE. The template is a JavaScript template literal
 * with interpolated blocks; extracting it with a regex would compare a reconstruction rather
 * than the artifact, which is the same mistake in a new place.
 *
 * Usage:  node scripts/check-server-compose.mjs [--bin ./apps/cli/dist/appbay]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// ⚠️ `yaml` is a dependency of packages/core, not of the workspace root, and pnpm's strict
// node_modules means a bare `import "yaml"` from scripts/ does not resolve. Same anchor the
// other check scripts use.
const parse = createRequire(
  new URL("../packages/core/package.json", import.meta.url),
)("yaml").parse;

const binIdx = process.argv.indexOf("--bin");
const BIN = binIdx > -1 ? process.argv[binIdx + 1] : "./apps/cli/dist/appbay";
const HARNESS = "docker-compose.server.yml";

if (!existsSync(BIN)) {
  console.error(`  ✖ binary not found at ${BIN} — run \`pnpm turbo build\` first`);
  process.exit(2);
}
if (!existsSync(HARNESS)) {
  // The harness file is private-tree only; the public subset has nothing to compare.
  console.log(`  – ${HARNESS} is absent — nothing to compare (expected in the public tree)`);
  process.exit(0);
}

/**
 * Keys that legitimately differ, each with the reason.
 *
 * ⚠️ Keep this list SHORT and justified. Every entry is a place where CI tests something an
 * installation does not run, which is exactly the failure this script exists to catch.
 */
const ALLOWED = new Map([
  ["build", "the harness builds the image from a source checkout; an install pulls it"],
  ["image", "the harness may pin a locally-built tag"],
]);

const home = mkdtempSync(join(tmpdir(), "appbay-server-compose-"));
let installed;
try {
  execFileSync(BIN, ["init", "--dir", home, "--yes"], {
    env: { ...process.env, APPBAY_HOME: home },
    stdio: "ignore",
  });
  installed = parse(readFileSync(join(home, "docker-compose.server.yml"), "utf-8"));
} finally {
  rmSync(home, { recursive: true, force: true });
}

const harness = parse(readFileSync(HARNESS, "utf-8"));

const problems = [];

function compareService(name) {
  const a = installed.services?.[name];
  const b = harness.services?.[name];
  if (!a || !b) {
    problems.push(
      `service "${name}" is ${a ? "missing from the harness" : "missing from what init writes"}`,
    );
    return;
  }
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (ALLOWED.has(key)) continue;
    const av = JSON.stringify(a[key]);
    const bv = JSON.stringify(b[key]);
    if (av !== bv) {
      problems.push(
        `services.${name}.${key} differs\n      installed: ${av}\n      harness  : ${bv}`,
      );
    }
  }
}

const services = [...new Set([
  ...Object.keys(installed.services ?? {}),
  ...Object.keys(harness.services ?? {}),
])];
for (const name of services) compareService(name);

for (const key of ["name", "volumes", "networks"]) {
  const av = JSON.stringify(installed[key]);
  const bv = JSON.stringify(harness[key]);
  if (av !== bv) {
    problems.push(`${key} differs\n      installed: ${av}\n      harness  : ${bv}`);
  }
}

if (problems.length > 0) {
  console.error("  ✖ the build harness does not match what `appbay init` writes:\n");
  for (const p of problems) console.error(`    ${p}\n`);
  console.error(
    "  Fix whichever is wrong. A harness that tests a topology no installation runs\n" +
      "  passes CI and proves nothing.",
  );
  process.exit(1);
}

console.log(
  `  ✓ ${HARNESS} matches what \`appbay init\` writes (${services.length} service(s) compared)`,
);
