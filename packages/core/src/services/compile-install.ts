/**
 * Compile the apps of one install, with the inputs every caller must pass and once forgot:
 * the project variables (without them every `${{project.DOMAIN}}` fails) and the runtime
 * facts (without them the GPU trait sees a host with no GPU). Five callers each carried
 * this block and its warnings; now they call this.
 */
import { join } from "node:path";
import { compile, type CompileResult } from "../compiler/compile.js";
import { detectRuntimeFacts } from "../runtime/facts.js";
import { loadProjectVars } from "./instance-vars.js";
import { NAMESPACES_DIR_REL } from "../schemas/namespace-values.js";

export interface CompileInstallOptions {
  /** Apps to compile; undefined means every installed app. */
  apps?: string[];
  /** Pre-loaded base values (DOMAIN), when the caller already has them. */
  projectVars?: Record<string, string>;
  /** The namespace for apps that pin none in their manifest. */
  namespace?: string;
}

export async function compileInstall(
  appbayHome: string,
  options: CompileInstallOptions = {},
): Promise<CompileResult> {
  const stateDir = join(appbayHome, "var", "lib", "state");
  return compile({
    appbayHome,
    appsDir: join(appbayHome, "etc", "apps"),
    rendersDir: join(appbayHome, "var", "lib", "renders"),
    stateDir,
    apps: options.apps,
    namespace: options.namespace,
    namespacesDir: join(appbayHome, NAMESPACES_DIR_REL),
    projectVars: options.projectVars ?? (await loadProjectVars(appbayHome)),
    runtimeFacts: detectRuntimeFacts({ stateDir }),
  });
}
