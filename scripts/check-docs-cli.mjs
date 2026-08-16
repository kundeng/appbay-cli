#!/usr/bin/env node
/**
 * Fail when the docs tell an operator to run something the binary does not have.
 *
 * 🚨 THIS EXISTS BECAUSE THE DOCS KEPT DESCRIBING A DIFFERENT PROGRAM. Found by hand in
 * one session:
 *   - README listed a system app (`authelia/`) deleted two sprints earlier
 *   - README omitted `setup`, `admin`, `edge`, `init-system` — every credential command
 *   - quickstart told operators to run `appbay setup --no-auth`, which has never existed
 *
 * Each was found by running the thing the doc described, never by reading the doc. A
 * reader cannot tell a real flag from an invented one; only the binary can.
 *
 * ⚠️ ASYMMETRIC ON PURPOSE. A documented-but-missing flag is a hard failure — someone
 * following the docs hits `error: unknown option`. An undocumented flag is only reported,
 * because a curated guide legitimately covers a subset.
 *
 * Usage:  node scripts/check-docs-cli.mjs [--bin ./apps/cli/dist/appbay]
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const binIdx = process.argv.indexOf("--bin");
const BIN = binIdx > -1 ? process.argv[binIdx + 1] : "./apps/cli/dist/appbay";

if (!existsSync(BIN)) {
  console.error(`  ✖ binary not found at ${BIN} — run \`pnpm turbo build\` first`);
  process.exit(2);
}

/** Ask the binary what it supports. The binary is the authority, not the source. */
function help(args) {
  try {
    return execFileSync(BIN, [...args, "--help"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return e.stdout ? String(e.stdout) : "";
  }
}

const topLevel = help([]);
const commands = [...topLevel.matchAll(/^ {2}([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);

// flags per command, plus the global set
const flagsFor = new Map([["", new Set([...topLevel.matchAll(/(--[a-z][a-z0-9-]*)/g)].map((m) => m[1]))]]);
/**
 * ⚠️ RECURSE TO ARBITRARY DEPTH. `appbay edge users create --email` is THREE levels, and a
 * two-level walk reports --email as nonexistent — 20 false positives on the first run.
 * Flags are collected against the TOP-LEVEL command, because that is the granularity the
 * docs are checked at; going finer would demand the docs name the full subcommand path in
 * every prose mention, which is not how anyone writes.
 */
function collectFlags(path, depth = 0) {
  const flags = new Set();
  if (depth > 3) return flags; // commander help is shallow; this is a runaway guard
  const text = help(path);
  for (const m of text.matchAll(/(--[a-z][a-z0-9-]*)/g)) flags.add(m[1]);
  const subs = [...text.matchAll(/^ {2}([a-z][a-z0-9-]*)/gm)].map((m) => m[1]).filter((s) => s !== "help");
  for (const sub of subs) for (const f of collectFlags([...path, sub], depth + 1)) flags.add(f);
  return flags;
}
for (const cmd of commands) flagsFor.set(cmd, collectFlags([cmd]));

/** Every markdown/qmd file that could instruct an operator. */
function docFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "_site" || entry === ".quarto" || entry === "node_modules" || entry === ".git") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) docFiles(p, acc);
    else if (/\.(md|qmd)$/.test(entry)) acc.push(p);
  }
  return acc;
}

const files = [...docFiles("docs"), ...(existsSync("README.md") ? ["README.md"] : [])];

const missingCmd = [];
const missingFlag = [];

for (const file of files) {
  const lines = readFileSync(file, "utf-8").split("\n");
  lines.forEach((line, i) => {
    // ⚠️ ONLY MATCH ACTUAL INVOCATIONS. Prose says things like "appbay consumes that
    // environment" and "the appbay user", and a bare /appbay \w+/ reports `consumes` and
    // `user` as missing commands — 7 false positives, which is how a check gets ignored.
    // A real invocation is either a fenced/inline code span, or a line that starts with
    // the command (optionally after a shell prompt).
    // Extract only the CODE parts of the line: a bare command line, or the contents of
    // inline `backticks`. Testing the whole line for "does it contain code somewhere" is
    // not enough — prose and code share a line constantly in tables and sentences, and the
    // prose then gets parsed as commands.
    const spans = /^\s*(\$\s*)?appbay\s/.test(line)
      ? [line]
      : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((s) => /\bappbay\s/.test(s));
    if (spans.length === 0) return;
    // ⚠️ FIRST INVOCATION PER SPAN ONLY. A command line runs one command; a second
    // `appbay <word>` later on the same line is descriptive text ("install Docker + appbay
    // user"), not a second invocation.
    for (const m of spans.map((s) => s.match(/\bappbay\s+([a-z][a-z0-9-]*)((?:\s+[^\s`|&;<>()$]+)*)/)).filter(Boolean)) {
      const cmd = m[1];
      if (!commands.includes(cmd)) {
        // `appbay <app>` style placeholders are not commands; only flag real-looking words.
        if (/^[a-z-]{3,}$/.test(cmd) && !/^(your|the|some|my|app|name)$/.test(cmd)) {
          missingCmd.push(`${file}:${i + 1}  appbay ${cmd}`);
        }
        continue;
      }
      const known = flagsFor.get(cmd) ?? new Set();
      const global = flagsFor.get("") ?? new Set();
      for (const f of (m[2] ?? "").matchAll(/(--[a-z][a-z0-9-]*)/g)) {
        if (!known.has(f[1]) && !global.has(f[1])) {
          missingFlag.push(`${file}:${i + 1}  appbay ${cmd} ${f[1]}`);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// tRPC routers vs docs/reference/api-endpoints.qmd
// ---------------------------------------------------------------------------
//
// 🚨 THIS DIRECTION IS THE ONE THAT ROTS SILENTLY. The CLI checks above catch docs that
// describe something the binary lacks — a documented ghost. They cannot catch the opposite:
// a router that EXISTS and is documented NOWHERE. `catalog` shipped in S05 and `edge` in
// S25, and neither appeared in the API reference; nothing failed, because nothing compared
// the two lists. A reader of the reference would conclude those endpoints do not exist.
const missingRouter = [];
const appRouterPath = "apps/web/src/server/routers/_app.ts";
const apiDocPath = "docs/reference/api-endpoints.qmd";
if (existsSync(appRouterPath) && existsSync(apiDocPath)) {
  const appSrc = readFileSync(appRouterPath, "utf-8");
  const body = appSrc.slice(appSrc.indexOf("appRouter = router({"));
  const routers = [...body.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*[a-zA-Z]+Router,/gm)].map((m) => m[1]);
  const docSrc = readFileSync(apiDocPath, "utf-8");
  const documented = new Set([...docSrc.matchAll(/^## ([a-zA-Z][a-zA-Z0-9]*)\s*$/gm)].map((m) => m[1]));
  for (const r of routers) {
    if (!documented.has(r)) missingRouter.push(`docs/reference/api-endpoints.qmd  missing "## ${r}"`);
  }
  console.log(`  routers: ${routers.length} registered, ${routers.length - missingRouter.length} documented`);
}

console.log(`  binary: ${BIN}  (${commands.length} commands)`);
console.log(`  docs:   ${files.length} files scanned\n`);

if (missingRouter.length) {
  console.log("  ❌ tRPC routers with no section in the API reference:");
  for (const x of [...new Set(missingRouter)]) console.log(`       ${x}`);
}

if (missingCmd.length) {
  console.log("  ❌ documented commands the binary does not have:");
  for (const x of [...new Set(missingCmd)]) console.log(`       ${x}`);
}
if (missingFlag.length) {
  console.log("  ❌ documented flags the binary does not accept:");
  for (const x of [...new Set(missingFlag)]) console.log(`       ${x}`);
}

const failures = new Set([...missingCmd, ...missingFlag, ...missingRouter]).size;
if (failures === 0) console.log("  ✅ every documented command and flag exists, and every router is documented");
console.log(`\n  ════ ${failures} discrepanc${failures === 1 ? "y" : "ies"} ════`);
process.exit(failures === 0 ? 0 : 1);
