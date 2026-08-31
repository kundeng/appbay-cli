#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "@appbay/core";
import { resolveAppbayHome } from "./utils/appbay-home.js";
import { initCommand } from "./commands/init.js";
import { initSystemCommand } from "./commands/init-system.js";
import { validateCommand } from "./commands/validate.js";
import { compileCommand } from "./commands/compile.js";
import { ejectCommand } from "./commands/eject.js";
import { listCommand } from "./commands/list.js";
import { statusCommand } from "./commands/status.js";
import { psCommand } from "./commands/ps.js";
import { upCommand } from "./commands/up.js";
import { downCommand } from "./commands/down.js";
import { restartCommand } from "./commands/restart.js";
import { rebuildCacheCommand } from "./commands/rebuild-cache.js";
import { logsCommand } from "./commands/logs.js";
import { secretsCommand } from "./commands/secrets.js";
import { doctorCommand } from "./commands/doctor.js";
import { serverCommand } from "./commands/server.js";
import { versionCommand } from "./commands/version.js";
import { configCommand } from "./commands/config.js";
import { openCommand } from "./commands/open.js";
import { homeCommand } from "./commands/home.js";
import { infoCommand } from "./commands/info.js";
import { pullCommand } from "./commands/pull.js";
import { deleteCommand } from "./commands/delete.js";
import { sizeCommand } from "./commands/size.js";
import { urlCommand } from "./commands/url.js";
import { updateCommand } from "./commands/update.js";
import { envCommand } from "./commands/env.js";
import { applyCommand } from "./commands/apply.js";
import { edgeCommand } from "./commands/edge.js";
import { retiredCommands } from "./commands/retired.js";
import { completionCommand } from "./commands/completion.js";
import { fixfsCommand } from "./commands/fixfs.js";
import { presetsCommand } from "./commands/presets.js";
import { installCommand } from "./commands/install.js";
import { catalogCommand } from "./commands/catalog.js";
import { setupCommand } from "./commands/setup.js";
import { execCommand, shellCommand, runCommand } from "./commands/exec.js";
import { statsCommand, smiCommand } from "./commands/stats.js";
import { modelsCommand } from "./commands/models.js";
import { ollamaCommand } from "./commands/ollama.js";
import { profileCommand } from "./commands/profile.js";
import { tunnelCommand, tunnelDownCommand } from "./commands/tunnel.js";
import { mcpCommand } from "./commands/mcp.js";
import { diveCommand } from "./commands/dive.js";

// ── Publish the CLI's resolved home into the environment, before any command runs ───────
//
// 🚨 THIS REPAIRS A WHOLE CLASS OF BUG, and it is one line because the alternative is
// threading `appbayHome` through 14 call sites that currently call core's `containerBin()`
// with no argument.
//
// Core resolves APPBAY_HOME with a DELIBERATELY simpler rule than the CLI does:
//
//   core   $APPBAY_HOME ?? ~/.appbay
//   CLI    $APPBAY_HOME > /etc/appbay/config > ~/.config/appbay/home > ~/.appbay
//
// That is by design — core must not grow a second copy of the CLI's lookup — but it only
// holds together if callers hand core the home the CLI already resolved. Where they do not,
// the two silently disagree, and core answers a question about the WRONG INSTALL.
//
// Measured on appbay-rhel (Fedora 43, podman, no docker installed), 2026-08-18:
//
//   sudo appbay edge users create u --generate
//     -> core containerBin() resolved /root/.appbay (root's homedir, no project.yaml)
//     -> no container_runtime key   -> fell back to DEFAULT_CONTAINER_RUNTIME = "docker"
//     -> spawn docker               -> ENOENT on a host that has only podman
//     -> "Caddy password hashing failed: null"
//
// while `/etc/appbay/config` said `home: /home/ubuntu/.appbay` and that install records
// `container_runtime: podman`. The CLI knew. Core was never told.
//
// ⚠️ Only set when ABSENT. An explicit $APPBAY_HOME is the highest-precedence tier in both
// resolvers; overwriting it here would make the two disagree again, in the other direction.
if (!process.env.APPBAY_HOME) {
  process.env.APPBAY_HOME = resolveAppbayHome();
}

const program = new Command();

program
  .name("appbay")
  .description("Appbay — self-hosted app management CLI")
  .version(VERSION);

// Bootstrap and system commands.
program.addCommand(setupCommand);
program.addCommand(initCommand);
program.addCommand(initSystemCommand);
program.addCommand(serverCommand);
program.addCommand(doctorCommand);
program.addCommand(versionCommand);

// Discovery and inspection commands.
program.addCommand(listCommand);
program.addCommand(statusCommand);
program.addCommand(psCommand);
program.addCommand(logsCommand);

// Validation, planning, and deployment commands.
program.addCommand(validateCommand);
program.addCommand(compileCommand);
program.addCommand(ejectCommand);
program.addCommand(applyCommand);
program.addCommand(upCommand);
program.addCommand(downCommand);
program.addCommand(restartCommand);
program.addCommand(pullCommand);
program.addCommand(deleteCommand);
program.addCommand(rebuildCacheCommand);

// Catalog and install commands.
program.addCommand(catalogCommand);
program.addCommand(installCommand);

// Config, secrets, and auth commands.
program.addCommand(configCommand);
program.addCommand(envCommand);
program.addCommand(presetsCommand);
program.addCommand(secretsCommand);
program.addCommand(edgeCommand);
// Retired commands: they only explain what replaced them, and still exit non-zero.
for (const c of retiredCommands) program.addCommand(c);

// Container interaction commands.
program.addCommand(execCommand);
program.addCommand(shellCommand);
program.addCommand(runCommand);
program.addCommand(statsCommand);
program.addCommand(smiCommand);

// Model management commands.
program.addCommand(modelsCommand);
program.addCommand(ollamaCommand);

// Profile and tunnel commands.
program.addCommand(profileCommand);
program.addCommand(tunnelCommand);
program.addCommand(tunnelDownCommand);
program.addCommand(mcpCommand);
program.addCommand(diveCommand);

// Utility commands.
program.addCommand(openCommand);
program.addCommand(urlCommand);
program.addCommand(homeCommand);
program.addCommand(infoCommand);
program.addCommand(sizeCommand);
program.addCommand(fixfsCommand);
program.addCommand(updateCommand);
program.addCommand(completionCommand);

program.parse();
