#!/usr/bin/env node
/**
 * Fail when the docs show an `appbay.yaml` the schema will not accept.
 *
 * 🚨 THIS EXISTS BECAUSE RFC-001 §4 RENAMED A FIELD AND THE REFERENCE KEPT TEACHING THE OLD
 * ONE. `docs/reference/appbay-yaml.qmd` documented `project:` / `environment:` in its field
 * table and in two complete examples, after both had become a parse error. A reader copying
 * the reference — the one document whose entire job is to be copied — got
 * `\`project:\` was removed in RFC-001 §4`. Found by parsing the docs, never by reading them.
 *
 * Sibling of `check-docs-cli.mjs`, same failure class: that one catches docs describing a
 * FLAG the binary does not have, this one catches docs describing a FIELD the schema rejects.
 * Neither is findable by review, because a reader cannot tell a real field from an invented
 * one — only the schema can.
 *
 * ⚠️ A block that is deliberately invalid — a migration "before", a WRONG example under an
 * anti-patterns heading — opts out with `# check-docs-manifests: ignore` on its own line.
 * Explicit, greppable, and visible to the reader as well as the checker.
 *
 * ⚠️ SKIPS FRAGMENTS ON PURPOSE. Guides legitimately show a few lines of a manifest without
 * the required keys around them, so a block is only checked when it parses to an object AND
 * its failures are attributable to a known field. A block failing only with "Required" is a
 * fragment, not a lie — see `isFragmentFailure`.
 *
 * Usage:  node scripts/check-docs-manifests.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Everything below is anchored to the repo, not to the caller's cwd, so this behaves the
// same from the root, from a package dir, or from CI.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ⚠️ `yaml` is a dependency of packages/core, not of the workspace root, and pnpm's strict
// node_modules means a bare `import "yaml"` from scripts/ does not resolve. Anchor the
// lookup where the package actually is rather than hoisting a dependency for one script.
const parseYaml = createRequire(
  new URL("../packages/core/package.json", import.meta.url),
)("yaml").parse;

const CORE_DIST = join(REPO_ROOT, "packages/core/dist/index.js");
if (!existsSync(CORE_DIST)) {
  console.error(`  ✖ ${CORE_DIST} not found — run \`pnpm turbo build\` first`);
  process.exit(2);
}
const { AppbayYamlSchema } = await import(`file://${CORE_DIST}`);

const DOC_ROOTS = ["docs/guide", "docs/reference"].map((d) => join(REPO_ROOT, d));

/** Every .qmd/.md under the given roots. */
function docFiles(roots) {
  const out = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (statSync(path).isFile() && /\.(qmd|md)$/.test(name)) out.push(path);
    }
  }
  return out;
}

/** ```yaml fenced blocks, with the 1-based line where each starts. */
function yamlBlocks(source) {
  const blocks = [];
  const lines = source.split("\n");
  let start = -1;
  let buf = [];
  for (const [i, line] of lines.entries()) {
    if (start === -1 && /^```ya?ml\s*$/.test(line)) {
      start = i + 2;
      buf = [];
    } else if (start !== -1 && /^```\s*$/.test(line)) {
      blocks.push({ line: start, body: buf.join("\n") });
      start = -1;
    } else if (start !== -1) {
      buf.push(line);
    }
  }
  return blocks;
}

/**
 * Not every yaml block in the docs is an `appbay.yaml`.
 *
 * ⚠️ `$APPBAY_HOME/project.yaml` legitimately has a `project:` key — it is the INSTANCE
 * config, a different file with a different schema — and checking it against the manifest
 * schema reported a real key as a removed one. Blocks whose leading comment names some other
 * file are skipped; blocks naming no file are still checked, since an unlabelled manifest
 * example is the common case and the one most likely to be copied.
 */
function namesADifferentFile(body) {
  const firstComment = body.split("\n").find((line) => line.trim().startsWith("#"));
  if (!firstComment) return false;
  if (/appbay\.yaml/.test(firstComment)) return false;
  return /\.(ya?ml|yml)\b/.test(firstComment);
}

/**
 * A failure that only says a required key is missing describes a FRAGMENT, which is a
 * legitimate way to document one section. Anything else — an unknown value, a removed
 * field, a wrong type — is the doc describing a manifest that cannot exist.
 */
function isFragmentFailure(issues) {
  return issues.every((issue) => issue.message === "Required");
}

let checked = 0;
const failures = [];

for (const file of docFiles(DOC_ROOTS)) {
  for (const { line, body } of yamlBlocks(readFileSync(file, "utf-8"))) {
    if (/^#\s*check-docs-manifests:\s*ignore\s*$/m.test(body)) continue;
    if (namesADifferentFile(body)) continue;

    let parsed;
    try {
      parsed = parseYaml(body);
    } catch {
      continue; // not YAML at all (templated snippets, partial structures)
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;

    const result = AppbayYamlSchema.safeParse(parsed);
    checked++;
    if (result.success || isFragmentFailure(result.error.issues)) continue;

    failures.push({
      file,
      line,
      messages: result.error.issues
        .filter((issue) => issue.message !== "Required")
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    });
  }
}

if (failures.length > 0) {
  console.error(`  ✖ ${failures.length} documented manifest(s) the schema rejects:\n`);
  for (const failure of failures) {
    console.error(`    ${failure.file.slice(REPO_ROOT.length + 1)}:${failure.line}`);
    for (const message of failure.messages) console.error(`      ${message}`);
    console.error("");
  }
  console.error("  A reader copying these gets the same error. Fix the doc, or the schema.");
  process.exit(1);
}

console.log(`  ✓ ${checked} documented manifest(s) parse against AppbayYamlSchema`);
