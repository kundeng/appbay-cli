#!/usr/bin/env node
/**
 * Refuse commits that touch both sides of the open-core boundary (S27).
 *
 * The private repo is a FORK of the public one, and public-set work reaches upstream by
 * cherry-pick. A commit spanning both sets cannot be cherry-picked without dragging
 * private files into a public repo, so the boundary has to hold at commit granularity —
 * not at review time, when the history is already written.
 *
 * Usage:
 *   check-straddle.mjs                 # staged files (pre-commit)
 *   check-straddle.mjs --range A..B    # every commit in a range (CI)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const boundary = JSON.parse(readFileSync(path.join(here, "split-boundary.json"), "utf8"));

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// Outside a work tree, `git diff --cached` silently falls back to --no-index and dies with
// "unknown option `cached'" plus a Node stack trace — which reads as a broken checker
// rather than a wrong working directory. Found running the materialised public tree before
// it had been `git init`ed.
try {
  const inTree = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"], // git's own "fatal:" would land before our message
  }).trim();
  if (inTree !== "true") throw new Error("not a work tree");
} catch {
  console.error("check-straddle: not inside a git work tree — nothing to check.");
  console.error("Run it from a checkout; the boundary is defined over tracked files.");
  process.exit(2);
}

/** A path belongs to a set if it equals or sits under one of its entries. */
const inSet = (file, set) =>
  set.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));

function classify(files) {
  const pub = files.filter((f) => inSet(f, boundary.public));
  const priv = files.filter((f) => inSet(f, boundary.private));
  return { pub, priv };
}

function report(label, pub, priv) {
  console.error(`\n✗ ${label} touches BOTH sides of the open-core boundary.\n`);
  console.error("  public set:");
  for (const f of pub) console.error(`    ${f}`);
  console.error("  private set:");
  for (const f of priv) console.error(`    ${f}`);
  console.error(
    "\n  Split it into two commits — the code, then its record. A commit spanning both",
  );
  console.error("  cannot be sent upstream by cherry-pick without leaking private files.");
  console.error("  Boundary is defined in scripts/split-boundary.json.\n");
}

const rangeFlag = process.argv.indexOf("--range");

if (rangeFlag !== -1) {
  const range = process.argv[rangeFlag + 1];
  if (!range) {
    console.error("--range needs a revision range, e.g. --range origin/master..HEAD");
    process.exit(2);
  }
  const commits = git("rev-list", range).split("\n").filter(Boolean);
  let bad = 0;
  for (const c of commits) {
    const files = git("show", "--pretty=", "--name-only", c).split("\n").filter(Boolean);
    const { pub, priv } = classify(files);
    if (pub.length && priv.length) {
      report(`${c.slice(0, 8)} ${git("log", "-1", "--format=%s", c)}`, pub, priv);
      bad++;
    }
  }
  if (bad) {
    console.error(`${bad} straddling commit(s) in ${range}.`);
    process.exit(1);
  }
  console.log(`No straddling commits in ${range} (${commits.length} checked).`);
  process.exit(0);
}

// Default: staged files, for pre-commit.
const staged = git("diff", "--cached", "--name-only", "--diff-filter=ACMR")
  .split("\n")
  .filter(Boolean);

if (staged.length === 0) process.exit(0);

const { pub, priv } = classify(staged);
if (pub.length && priv.length) {
  report("This commit", pub, priv);
  console.error("  To bypass for a genuine one-off: git commit --no-verify\n");
  process.exit(1);
}

process.exit(0);
