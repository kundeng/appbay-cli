#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "@appbay/core";
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
import { adminCommand } from "./commands/admin.js";
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
program.addCommand(adminCommand);
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
