#!/usr/bin/env node
/**
 * Verify the invariant the open-core split rests on: the public tree is a strict SUBSET of
 * the private one at identical paths.
 *
 * 🚨 THIS EXISTS BECAUSE "BOTH TREES GREEN" IS NOT THE SAME CLAIM. Running the suite in each
 * repo proves each repo is internally consistent; it says nothing about whether they agree.
 * Twice in one session a public-set commit was made to one tree and never carried to the
 * other — a `specs/` file and the boundary definition itself — and every per-repo check
 * stayed green throughout, because none of them compares the trees.
 *
 * Two things are checked:
 *
 *   1. **Subset.** Every path tracked in public must exist in private. A file that exists
 *      only in public cannot be merged down and will conflict on the next `git merge
 *      upstream/main`.
 *   2. **Agreement.** Every shared path must be byte-identical. `packages/`, `apps/cli/`,
 *      `docs/guide/`, `specs/`, `scripts/split-boundary.json` and the root config are all
 *      public-set or shared, and a divergence means the two `check-straddle.mjs` runs are
 *      reading different rules, or the sprint record differs depending on where you look.
 *
 * ⚠️ LOCAL ONLY — it needs both clones, so it cannot run in CI, which checks out one repo.
 * Run it before claiming the trees are in sync.
 *
 * ⚠️ COMPARES THE INDEX, NOT THE WORKING TREE. An uncommitted, unstaged edit is invisible
 * here — which is correct for the failure this guards (a commit that reached one tree and
 * not the other) and wrong if you expect it to police a dirty checkout. Stage or commit
 * first, or it will tell you the trees agree while your editor says otherwise.
 *
 * Usage:  node scripts/check-subset.mjs [--other ../appbay]
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

/**
 * The sibling clone, derived from THIS repo's name rather than a fixed relative path.
 *
 * ⚠️ A hardcoded `../appbay` default resolves to the repo itself when run from `appbay`,
 * so the check compared a tree to itself and printed ✓ — a false pass, which is worse than
 * an error because it answers the question wrongly instead of declining to answer.
 */
const otherIdx = process.argv.indexOf("--other");
const sibling = basename(REPO) === "appbay-cli" ? "appbay" : "appbay-cli";
const OTHER = resolve(
  otherIdx > -1 ? process.argv[otherIdx + 1] : join(REPO, "..", sibling),
);

if (OTHER === REPO) {
  console.error(`  ✖ --other resolves to this repo (${REPO}); nothing to compare`);
  process.exit(2);
}

if (!existsSync(join(OTHER, ".git"))) {
  console.log(`  – skipped: no sibling clone at ${OTHER} (this check is local-only)`);
  process.exit(0);
}

/** Which of the two is the public subset? The one without `apps/web`. */
const [pub, priv] = existsSync(join(REPO, "apps/web")) ? [OTHER, REPO] : [REPO, OTHER];

/**
 * path -> "<mode> <blob-sha>", straight from the index.
 *
 * ⚠️ Compare git's own hashes rather than reading files. `.agents/skills/*` are SYMLINKS
 * (mode 120000) pointing at a macOS path that does not exist here, so `readFileSync` raised
 * EISDIR and killed the run. Modes also make the check stricter for free: a file that became
 * a symlink, or lost its executable bit, differs even when the bytes match.
 */
const indexOf = (repo) =>
  new Map(
    execFileSync("git", ["-C", repo, "ls-files", "-s"], { encoding: "utf-8" })
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t");
        const [mode, sha] = meta.split(" ");
        return [path, `${mode} ${sha}`];
      }),
  );

const publicIndex = indexOf(pub);
const privateIndex = indexOf(priv);
const publicFiles = new Set(publicIndex.keys());
const privateFiles = new Set(privateIndex.keys());

const orphaned = [...publicFiles].filter((f) => !privateFiles.has(f)).sort();
const diverged = [...publicFiles]
  .filter((f) => privateFiles.has(f) && publicIndex.get(f) !== privateIndex.get(f))
  .sort();

console.log(`  public:  ${pub}  (${publicFiles.size} tracked)`);
console.log(`  private: ${priv}  (${privateFiles.size} tracked)`);

if (orphaned.length === 0 && diverged.length === 0) {
  console.log(`  ✓ public is a strict subset of private, and every shared path agrees`);
  process.exit(0);
}

if (orphaned.length > 0) {
  console.error(`\n  ✖ ${orphaned.length} path(s) in public with no counterpart in private:`);
  for (const f of orphaned) console.error(`      ${f}`);
  console.error("    These cannot be merged down and will conflict on the next merge.");
}

if (diverged.length > 0) {
  console.error(`\n  ✖ ${diverged.length} shared path(s) whose content differs:`);
  for (const f of diverged) console.error(`      ${f}`);
  console.error("    A public-set commit reached one tree and not the other.");
}

process.exit(1);
