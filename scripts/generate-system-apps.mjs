#!/usr/bin/env node
/**
 * Generate packages/core/src/system-apps.ts from the system-apps/ directory.
 *
 * WHY THIS EXISTS. There were two copies of every system app and only one shipped:
 *
 *   system-apps/<name>/…              a real directory, human-editable, read by NOTHING
 *   packages/core/src/system-apps.ts  embedded strings — what `appbay init` actually seeds
 *
 * Nothing sat between them, so they drifted. Measured 2026-08-07 before this landed: 8
 * files differed and 2 whole apps (homepage, keeweb) existed ONLY as embedded strings.
 * Worse, the documentation pointed at the directory, so a contributor following it edited
 * a copy that shipped nothing and had no way to tell whether the change was wrong or
 * simply discarded.
 *
 * It cost something concrete: a `depends_on: [socket-proxy]` left in traefik after that
 * app was deleted made the DEFAULT INGRESS undeployable — compose rejects the whole
 * project on a dangling dependency — and nobody noticed, because nothing reads the
 * directory.
 *
 * ⇒ The directory is now AUTHORED and this file is GENERATED. One source, one direction.
 *
 * ⚠️ THE OUTPUT IS COMMITTED, not gitignored. `appbay init` seeds from the compiled
 * binary, and bun-compiled binaries cannot read files relative to the source tree — that
 * is the original reason for embedding. Committing the generated file keeps a plain
 * `pnpm build` working without a codegen step having to run first in every environment.
 *
 *   node scripts/generate-system-apps.mjs           write it
 *   node scripts/generate-system-apps.mjs --check   verify it is current (CI / tests)
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SRC_DIR = join(ROOT, "system-apps");
const OUT = join(ROOT, "packages", "core", "src", "system-apps.ts");

/**
 * Files that are inputs to the build rather than app content.
 *
 * ⚠️ `.example` files ARE included on purpose — config/global/acme.caddy.example is how an
 * operator learns the InCommon ACME shape, and it is useless if it does not ship.
 */
const SKIP = new Set([".DS_Store", ".gitkeep"]);

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP.has(entry)) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, base));
    else out.push(relative(base, abs).split(sep).join("/"));
  }
  return out;
}

/**
 * Escape a file's contents for a TS template literal.
 *
 * ⚠️ `${` MUST be escaped. These files are full of `${APPBAY_CADDY_IMAGE:-…}` and
 * `${TZ:-UTC}`; without this they become TypeScript interpolation and either fail to
 * compile or, worse, silently evaluate to something else.
 */
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const apps = readdirSync(SRC_DIR)
  .filter((n) => statSync(join(SRC_DIR, n)).isDirectory())
  .sort();

let body = "";
for (const app of apps) {
  const files = walk(join(SRC_DIR, app));
  if (!files.includes("docker-compose.yml")) {
    console.error(
      `✗ ${app}/ has no docker-compose.yml — a directory without one is not an app, and ` +
        `seeding keys on that file. Refusing to emit it.`,
    );
    process.exit(1);
  }
  body += `  {\n    name: ${JSON.stringify(app)},\n    files: {\n`;
  for (const f of files) {
    body += `      ${JSON.stringify(f)}: \`${esc(readFileSync(join(SRC_DIR, app, f), "utf-8"))}\`,\n`;
  }
  body += `    },\n  },\n`;
}

const generated = `/**
 * Embedded system app definitions.
 *
 * 🚨 GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source of truth is the \`system-apps/\` directory at the repo root. Regenerate with:
 *
 *     node scripts/generate-system-apps.mjs
 *
 * An edit made here is lost on the next build. An edit made in \`system-apps/\` without
 * regenerating is caught by the test that runs this script with --check.
 *
 * These definitions are bundled into the compiled binary so that \`appbay init\` can seed
 * system apps without reading files relative to the source tree — which is unavailable in
 * a bun-compiled binary, where \`import.meta.dirname\` does not resolve to anything useful.
 */

/** A single system app definition with its file contents. */
export interface SystemAppDef {
  /** App directory name (e.g. "traefik"). */
  name: string;
  /** Map of relative file paths to their string contents. */
  files: Record<string, string>;
}

/** All built-in system app definitions, generated from system-apps/. */
export const SYSTEM_APPS: SystemAppDef[] = [
${body}];
`;

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf-8");
  if (current !== generated) {
    console.error(
      "✗ packages/core/src/system-apps.ts is STALE.\n" +
        "  It does not match what system-apps/ would generate, so what ships and what is\n" +
        "  reviewable have drifted — the exact condition this generator was added to end.\n" +
        "  Fix: node scripts/generate-system-apps.mjs",
    );
    process.exit(1);
  }
  console.log(`✓ system-apps.ts is current (${apps.length} apps)`);
} else {
  writeFileSync(OUT, generated, "utf-8");
  console.log(`✓ generated ${apps.length} apps -> ${relative(ROOT, OUT)}`);
}
