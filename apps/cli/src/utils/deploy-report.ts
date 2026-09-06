/**
 * The one printer for a deploy result. `up`, `apply` and `restart` deploy through core's
 * `deploy()`; a second copy of this report is how a fix reaches one command and not the
 * other (review 2026-09-05, F2).
 */
import type { DeployResult } from "@appbay/core";
import { pad } from "./formatting.js";

export function printDeployReport(result: DeployResult): { hasFailures: boolean } {
  // 🚨 The bracket is prefixed `plan:` because it is a verdict about the COMPILED
  // ARTIFACT, and a bare `[UNCHANGED]` was read — by operators and by this command's own
  // summary — as a verdict about the deployment (appbay-cli#4). They disagree exactly
  // when it matters: an unchanged plan whose container is gone. What the converge did to
  // the containers is said separately, in words, on its own line.
  for (const app of result.apps) {
    const statusLabel = app.planStatus === "new" ? "NEW"
      : app.planStatus === "changed" ? "CHANGED"
      : "UNCHANGED";
    const sysTag = app.isSystem ? " (system)" : "";

    if (app.status === "deployed") {
      console.log(`  ${pad(app.appName, 14)} [plan: ${statusLabel}]${sysTag}`);
      console.log(
        app.planStatus === "unchanged" && app.convergeAction === "started"
          ? `  Started ${app.appName} — the plan was unchanged, the container was not`
          : `  Started ${app.appName}`,
      );
    } else if (app.status === "failed") {
      console.error(`  Failed: ${app.appName} — ${app.error}`);
    } else {
      // `unknown` means compose could not be asked what it did — say so rather than
      // let silence read as "already running".
      const note = app.convergeAction === "unknown"
        ? `  (could not read container state: ${app.unknownReason ?? "compose did not answer"})`
        : "";
      console.log(`  - ${pad(app.appName, 14)} [plan: ${statusLabel}]${note}`);
    }
    // A post-deploy action that failed did not fail the app, and it is not silent either.
    for (const err of app.shepherdErrors ?? []) console.error(`    post-deploy: ${err}`);
  }

  if (result.warnings?.length) {
    console.log("");
    for (const warn of result.warnings) {
      console.log(`  ⚠ ${warn}`);
    }
  }

  // 🚨 `failed` MUST be counted here. It used to report only compileErrors.length, so a
  // deploy that printed "Failed: hello — no such image" one line earlier then summarised
  // itself as "0 deployed, 0 unchanged, 0 ERROR(S)". A trailing "0 errors" is what a human
  // and a CI log scraper both read as success.
  //
  // Compile and deploy failures are counted separately because they fail at different
  // stages and are fixed in different places: a compile error is a bad appbay.yaml or
  // overlay, a deploy failure is the runtime refusing the rendered file.
  const errorCount = result.failed + result.compileErrors.length;
  console.log(
    `\n${result.deployed} deployed, ${result.unchanged} unchanged, ${errorCount} error(s)`,
  );

  // A PARTIAL converge gets its own line rather than being folded into either count
  // (appbay-cli#5): the app is up, and it is unreachable — a missing route or a container
  // that never became ready — which is what the operator has to clean up.
  if (result.startedButUnrouted > 0) {
    console.log(
      `  ⚠ ${result.startedButUnrouted} app(s) STARTED but are NOT reachable — their containers ` +
        `are running and their routes are not installed or they never became ready.`,
    );
  }

  return { hasFailures: result.failed > 0 || result.compileErrors.length > 0 };
}
