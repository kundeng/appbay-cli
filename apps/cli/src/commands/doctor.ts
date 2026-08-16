/**
 * `appbay doctor` command.
 *
 * Runs prerequisite and health checks for the Appbay environment by delegating
 * to the shared checks module (`utils/checks.ts`). Reports a pass/fail status
 * per check with actionable fix suggestions, plus a summary remediation block.
 *
 * Options:
 *   --json   machine/AI-readable output: `{ ok, checks[] }` with flat
 *            `{ name, passed, detail, fix, required }` entries.
 *
 * Exit codes:
 *   0 -- all required checks passed
 *   1 -- one or more required checks failed
 */

import { Command } from "commander";
import {
  runChecks,
  requiredChecksFailed,
  formatCheck,
  formatRemediation,
  buildDoctorJson,
  type CheckResult,
} from "../utils/checks.js";

export const doctorCommand = new Command("doctor")
  .description("Check Appbay prerequisites and environment health")
  .option("--json", "output machine-readable JSON")
  .action(async (options: { json?: boolean }) => {
    const checks: CheckResult[] = await runChecks();

    if (options.json) {
      const payload = buildDoctorJson(checks);
      console.log(JSON.stringify(payload, null, 2));
      process.exit(payload.ok ? 0 : 1);
    }

    console.log("Appbay Doctor\n");

    for (const check of checks) {
      console.log(formatCheck(check));
    }

    console.log("");
    const remediation = formatRemediation(checks);
    if (remediation) {
      console.log(remediation);
      console.log("");
    }

    const failed = requiredChecksFailed(checks);
    if (failed.length > 0) {
      console.log(`${failed.length} required check(s) failed.`);
      process.exit(1);
    } else {
      console.log("All required checks passed.");
    }
  });

