/**
 * Top-level compile() orchestrator -- wires the full compiler pipeline.
 *
 * Pipeline stages (in order):
 *   1. Discover -- scan appsDir, filter to requested apps
 *   2. For each app:
 *      a. Upstream transform -- if appbayConfig has upstream, transform it
 *      b. Resolve variables -- resolve ${{scope.KEY}} refs in compose
 *      c. Select overlays -- evaluate when clauses against the INSTALLED app set
 *      d. Apply traits -- run trait engine with registry
 *      e. Render -- assemble final compose YAML
 *      f. Plan -- diff against current rendered file on disk
 *   3. Collect -- aggregate results, errors, warnings
 *
 * Error handling:
 *   - Discovery errors are collected but do not stop other apps.
 *   - Per-app errors result in that app's compile being skipped; other apps
 *     continue.
 *   - If no apps are found, the result has empty apps and an error.
 *
 * See design.md "Compiler Pipeline" and agents.md "Primary design goal".
 */

import { readFile } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RuntimeFacts } from "../schemas/runtime-facts.js";
import type { AppbayYaml } from "../schemas/appbay-yaml.js";
import { TraitRegistry } from "../traits/registry.js";
import { registerCoreTraits } from "../traits/definitions/index.js";
import { GeneratedValueStore, parseMagicVar } from "../state/generated-values.js";
import { discoverApps } from "./discover.js";
import { transformUpstream } from "./upstream-transform.js";
import { ScopeResolver } from "./scope-resolver.js";
import { selectActiveOverlays } from "./overlay-engine.js";
import type { ActiveOverlay } from "./overlay-engine.js";
import { applyTraits } from "./trait-engine.js";
import { renderCompose } from "./renderer.js";
import { generatePlan } from "./plan.js";
import type { DiscoveredApp } from "./types.js";
import type { Plan } from "./plan.js";
import { containerBin, resolveIngressProvider } from "../runtime/container-runtime.js";
import { readFileSync } from "node:fs";
import { parseInstanceConfig } from "../schemas/instance.js";
import { resolveBuilds, buildShepherdAction } from "./builds.js";

/**
 * What an operator can actually do about an unresolved `${{scope.KEY}}` reference.
 *
 * 🚨 THE OLD TEXT NAMED FOUR THINGS AND THREE DID NOT EXIST: "Define the variable in
 * project.yaml or environment.yaml, or use --project-vars / --env-vars flags." Measured —
 * `--project-vars` and `--env-vars` are not commander options anywhere in the CLI, and
 * nothing reads `environment.yaml`. The one message a stuck operator gets sent them to two
 * flags the binary rejects and a file it never opens. RFC-001 §4.8.
 *
 * What is real: `loadProjectVars` reads a single `domain:` line from
 * `$APPBAY_HOME/project.yaml` and exposes it as `${{project.DOMAIN}}`. The `environment` and
 * `service` maps are threaded through the compiler but nothing populates them, so a
 * reference to either can never resolve — and saying that is more use than naming a file to
 * go and edit.
 */
function scopeErrorSuggestion(scope: string): string {
  if (scope === "project") {
    return (
      "Only ${{project.DOMAIN}} is available today, from the `domain:` line in " +
      "$APPBAY_HOME/project.yaml. No other project-level variables are loaded."
    );
  }
  if (scope === "environment" || scope === "service") {
    return (
      `The \`${scope}\` scope is declared but nothing populates it, so no ` +
      `\${{${scope}.KEY}} reference can resolve. Use \${{project.DOMAIN}}, or a plain ` +
      "Compose ${VAR} read from the app's .env."
    );
  }
  return "Valid scopes are: project, environment, service.";
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for the compile() orchestrator.
 *
 * ⚠️ There is deliberately no `activeApps` here. Overlays used to be evaluated against a
 * `podman ps` snapshot passed in by the caller; RFC-001 §5 makes `when:` mean *installed*,
 * which is a fact about the declared app set. It is derived inside `compile()` rather than
 * accepted as input, because it must be the FULL declared set — accepting it from the caller
 * is exactly how `appbay up openwebui` and `appbay up` came to produce different artifacts.
 */
export interface CompileOptions {
  /** Path to apps directory (e.g., $APPBAY_HOME/etc/apps). */
  appsDir: string;
  /** Path to rendered output directory (for diff against current state). */
  rendersDir: string;
  /** Path to state directory (for generated values). */
  stateDir: string;
  /** Specific apps to compile (default: all discovered). */
  apps?: string[];
  /** Runtime facts for trait context. */
  runtimeFacts?: RuntimeFacts;
  /** Deployment namespace (default: "default"). RFC-001 §4. */
  namespace?: string;
  /** Project-level variables for scope resolution. */
  projectVars?: Record<string, string>;
  /** Environment-level variables for scope resolution. */
  environmentVars?: Record<string, string>;
}

/** A single logical change entry (trait attached, overlay activated, etc.). */
export interface LogicalChangeEntry {
  type: "trait" | "overlay" | "scope" | "image";
  op: "+" | "-" | "~";
  /** Short label: trait type name, overlay condition, etc. */
  text: string;
  /** Secondary detail line. */
  detail: string;
}

/** Logical changes grouped by app + service (service="" means app-level). */
export interface LogicalGroup {
  app: string;
  svc: string;
  changes: LogicalChangeEntry[];
}

/** Result of compiling a single app. */
export interface AppCompileResult {
  /** App name (directory name). */
  appName: string;
  /** Rendered compose YAML string. */
  rendered: string;
  /** Plan/diff against current state on disk. */
  plan: Plan;
  /** Auxiliary files generated by trait transforms. */
  auxiliaryFiles: Array<{ path: string; content: string }>;
  /**
   * Metadata emitted by trait transforms for out-of-band consumers.
   * Keyed by trait type. Used by the job queue scheduler (e.g., to discover
   * which apps have backup schedules and their retention settings).
   */
  traitMetadata: Record<string, Record<string, unknown>>;
  /** Shepherd actions emitted by traits (operational lifecycle tasks). */
  shepherdActions: import("../traits/types.js").ShepherdAction[];
  /** Structured logical changes: which traits/overlays were applied. */
  logicalChanges: LogicalGroup[];
}

/** An error encountered during compilation. */
export interface CompileError {
  /** App name (if the error is app-specific). */
  appName?: string;
  /** Which pipeline stage failed. */
  stage: string;
  /** Human-readable error message. */
  message: string;
  /** Actionable suggestion for fixing the error. */
  suggestion?: string;
  /** Additional error details. */
  details?: unknown;
}

/** Result of the full compile pipeline. */
export interface CompileResult {
  /** Per-app compile results. */
  apps: AppCompileResult[];
  /** Errors encountered during compilation. */
  errors: CompileError[];
  /** Warnings collected during compilation. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Default runtime facts (used when none provided)
// ---------------------------------------------------------------------------

const DEFAULT_RUNTIME_FACTS: RuntimeFacts = {
  gpu: { available: false, cdiSupported: false },
  docker: {
    version: "0.0.0",
    composeVersion: "0.0.0",
    socketPath: "/var/run/docker.sock",
  },
  os: { platform: "linux", arch: "x64", version: "unknown" },
  disk: { availableGb: 0, totalGb: 0 },
  operatorId: "local",
};

// ---------------------------------------------------------------------------
// Main compile function
// ---------------------------------------------------------------------------

/**
 * Run the full compiler pipeline: discover, transform, resolve, overlay,
 * trait, render, plan.
 *
 * This is the top-level entry point for the compiler. It orchestrates all
 * pipeline stages and aggregates results, errors, and warnings.
 */
export async function compile(options: CompileOptions): Promise<CompileResult> {
  const {
    appsDir,
    rendersDir,
    stateDir,
    apps: requestedApps,
    runtimeFacts = DEFAULT_RUNTIME_FACTS,
    namespace,
    projectVars = {},
    environmentVars = {},
  } = options;

  const results: AppCompileResult[] = [];
  const errors: CompileError[] = [];
  const warnings: string[] = [];

  // -------------------------------------------------------------------------
  // Stage 1: Discover
  // -------------------------------------------------------------------------

  let discovered: DiscoveredApp[];
  try {
    discovered = await discoverApps({ appsDir });
  } catch (err) {
    errors.push({
      stage: "discover",
      message: `Discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      suggestion: `Check that ${appsDir} exists and contains app directories with docker-compose.yml files.`,
      details: err,
    });
    return { apps: [], errors, warnings };
  }

  // Collect discovery-level errors from each app.
  for (const app of discovered) {
    for (const discErr of app.errors) {
      errors.push({
        appName: app.name,
        stage: "discover",
        message: discErr.message,
        details: discErr.details,
      });
    }
  }

  // RFC-001 §5.2: the installed set is the FULL declared set, captured BEFORE the target
  // filter below. That ordering is the whole fix — evaluating `when:` against the filtered
  // set meant `appbay up openwebui` saw one app installed and `appbay up` saw all of them,
  // so the same manifest compiled to different artifacts depending on the command line.
  const installedApps = new Set(discovered.map((app) => app.name));

  // Filter to requested apps if specified.
  if (requestedApps && requestedApps.length > 0) {
    const requested = new Set(requestedApps);
    discovered = discovered.filter((app) => requested.has(app.name));
  }

  // If no apps found, return empty result with informational error.
  if (discovered.length === 0) {
    return { apps: [], errors, warnings };
  }

  // -------------------------------------------------------------------------
  // Set up shared resources
  // -------------------------------------------------------------------------

  // Trait registry with all core traits registered.
  const registry = new TraitRegistry();
  registerCoreTraits(registry);

  // Generated value store.
  const generatedValueStore = new GeneratedValueStore(
    join(stateDir, "generated-values.yaml"),
  );

  // -------------------------------------------------------------------------
  // Stage 2: Process each app
  // -------------------------------------------------------------------------

  for (const app of discovered) {
    try {
      const appResult = await compileApp({
        app,
        appsDir,
        rendersDir,
        installedApps,
        runtimeFacts,
        registry,
        generatedValueStore,
        namespace,
        projectVars,
        environmentVars,
      });

      results.push(appResult.result);

      // Collect per-app errors and warnings.
      for (const err of appResult.errors) {
        errors.push(err);
      }
      for (const warn of appResult.warnings) {
        warnings.push(warn);
      }
    } catch (err) {
      errors.push({
        appName: app.name,
        stage: "compile",
        message: `Unexpected error compiling "${app.name}": ${err instanceof Error ? err.message : String(err)}`,
        details: err,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Stage 3: Post-compile validations
  // -------------------------------------------------------------------------

  // Detect ingress host conflicts — two different apps claiming the same hostname.
  //
  // 🚨 THIS CHECK WAS DEAD ON THE DEFAULT EDGE. It only inspected files under
  // `traefik/config/dynamic` and only matched Traefik's Host(`…`) matcher, so once S25 made
  // Caddy the default it skipped every artifact and found nothing — two apps could claim
  // one hostname, both deploy "successfully", and whichever the edge routed, the other
  // silently never received traffic. Measured: `appbay compile conf-a conf-b`, both
  // declaring `dup.test.local`, reported "2 compiled, 0 error(s)".
  //
  // ⚠️ Scanning ARTIFACTS rather than trait metadata is deliberate. Trait metadata merges
  // with Object.assign keyed by trait type (trait-engine.ts), so an app with two ingress
  // traits would overwrite its own entry and lose a host. One artifact per route means
  // multiple routes per app are handled by construction.
  const hostMap = new Map<string, Set<string>>();
  const claim = (host: string, appName: string): void => {
    const existing = hostMap.get(host);
    if (existing) existing.add(appName);
    else hostMap.set(host, new Set([appName]));
  };
  for (const app of results) {
    for (const aux of app.auxiliaryFiles) {
      if (aux.path.includes("traefik/config/dynamic")) {
        // Traefik: routers carry a Host(`example.test`) matcher.
        const traefikRe = /Host\(`([^`]+)`\)/g;
        let match;
        while ((match = traefikRe.exec(aux.content)) !== null) claim(match[1], app.appName);
      } else if (aux.path.includes("caddy/config/dynamic") && aux.path.endsWith(".caddy")) {
        // Caddy: a site block opens with the address, e.g. `whoami.test.local {`.
        // Anchored to column 0 so nested blocks inside the site body cannot match.
        const caddyRe = /^([A-Za-z0-9*][^\s{]*)\s*\{/gm;
        let match;
        while ((match = caddyRe.exec(aux.content)) !== null) claim(match[1], app.appName);
      }
    }
  }
  for (const [host, apps] of hostMap) {
    if (apps.size > 1) {
      warnings.push(
        `Ingress host conflict: ${host} is claimed by ${[...apps].join(", ")}. Only one app can serve a given hostname.`,
      );
    }
  }

  // Flush generated values to disk after all apps are processed.
  try {
    await generatedValueStore.flush();
  } catch (err) {
    warnings.push(
      `Failed to flush generated values: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { apps: results, errors, warnings };
}

// ---------------------------------------------------------------------------
// Per-app compile
// ---------------------------------------------------------------------------

interface CompileAppInput {
  app: DiscoveredApp;
  appsDir: string;
  rendersDir: string;
  installedApps: Set<string>;
  runtimeFacts: RuntimeFacts;
  registry: TraitRegistry;
  generatedValueStore: GeneratedValueStore;
  /** Namespace from the invocation. Undefined means "the manifest decides". */
  namespace: string | undefined;
  projectVars: Record<string, string>;
  environmentVars: Record<string, string>;
}

interface CompileAppOutput {
  result: AppCompileResult;
  errors: CompileError[];
  warnings: string[];
}

/**
 * Compile a single app through the full pipeline.
 */
async function compileApp(input: CompileAppInput): Promise<CompileAppOutput> {
  const {
    app,
    appsDir,
    rendersDir,
    installedApps,
    runtimeFacts,
    registry,
    generatedValueStore,
    namespace: invocationNamespace,
    projectVars,
    environmentVars,
  } = input;

  const errors: CompileError[] = [];
  const warnings: string[] = [];

  const config = app.appbayConfig;
  // Manifest wins when it pins one; otherwise the invocation decides. This `??` was
  // already written this way and could never fire, because the fields carried a Zod
  // default. Making the schema field `.optional()` is what makes it correct.
  const appNamespace = config?.namespace ?? invocationNamespace ?? "default";
  const sharedNetworks = config?.shared_network ?? ["appbay_shared"];

  let compose: Record<string, unknown> = { ...app.composeContent };

  // -----------------------------------------------------------------------
  // Stage 2a: Upstream transform
  // -----------------------------------------------------------------------

  if (config?.upstream) {
    try {
      // Compute relative path from the render output dir to the apps dir.
      // Rendered compose lives at rendersDir/<appName>/docker-compose.rendered.yml,
      // so Docker Compose resolves relative paths from rendersDir/<appName>/.
      const appsRelPath = relative(join(rendersDir, app.name), appsDir);
      const transformed = transformUpstream({
        appName: app.name,
        namespace: appNamespace,
        compose,
        upstream: config.upstream,
        sharedNetworks,
        appsDir,
        appsRelPath,
      });
      compose = transformed.compose;
    } catch (err) {
      errors.push({
        appName: app.name,
        stage: "upstream-transform",
        message: `Upstream transform failed: ${err instanceof Error ? err.message : String(err)}`,
        suggestion: `Check upstream.source path in appbay.yaml. Run: appbay validate ${app.name}`,
        details: err,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Stage 2b: Resolve scoped variables (${{scope.KEY}})
  // -----------------------------------------------------------------------

  const scopeResolver = new ScopeResolver({
    project: projectVars,
    environment: environmentVars,
    service: {},
  });

  const { result: resolvedCompose, errors: scopeErrors } =
    scopeResolver.resolveObject(compose);
  compose = resolvedCompose;

  for (const scopeErr of scopeErrors) {
    errors.push({
      appName: app.name,
      stage: "resolve-variables",
      message: scopeErr.message,
      suggestion: scopeErrorSuggestion(scopeErr.scope),
    });
  }

  // -----------------------------------------------------------------------
  // Stage 2b2: Resolve magic variables (${password:16}, ${uuid}, etc.)
  // -----------------------------------------------------------------------

  compose = await resolveMagicVars(
    compose,
    generatedValueStore,
    appNamespace,
    app.name,
  );

  // -----------------------------------------------------------------------
  // Stage 2c: Select overlays
  // -----------------------------------------------------------------------

  let overlayServices: Record<string, Record<string, unknown>> = {};
  let activeOverlaysForLog: ActiveOverlay[] = [];

  if (config?.overlays && config.overlays.length > 0) {
    const overlayResult = selectActiveOverlays({
      overlays: config.overlays,
      installedApps,
    });
    activeOverlaysForLog = overlayResult.activeOverlays;

    // Collect overlay service fragments for the renderer.
    if (overlayResult.activeOverlays.length > 0) {
      for (const overlay of overlayResult.activeOverlays) {
        for (const [svcName, fragment] of Object.entries(overlay.services)) {
          if (overlayServices[svcName]) {
            // Merge multiple overlay fragments targeting the same service.
            overlayServices[svcName] = {
              ...overlayServices[svcName],
              ...fragment,
            };
          } else {
            overlayServices[svcName] = { ...fragment };
          }
        }
      }
    }

    // Report inactive overlays as informational warnings.
    for (const inactive of overlayResult.inactiveOverlays) {
      warnings.push(
        `[${app.name}] Overlay skipped: ${inactive.reason}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Stage 2d: Apply traits
  // -----------------------------------------------------------------------

  let auxiliaryFiles: Array<{ path: string; content: string }> = [];
  let traitMetadata: Record<string, Record<string, unknown>> = {};
  let shepherdActions: import("../traits/types.js").ShepherdAction[] = [];

  // Resolve ${{scope.KEY}} variables in trait properties before trait engine runs.
  const rawAppTraits = (config?.traits ?? []) as Array<{
    type: string;
    [key: string]: unknown;
  }>;
  let traitScopeResolutionFailed = false;
  const resolveTrait = (
    trait: { type: string; [key: string]: unknown },
    service?: string,
  ): { type: string; [key: string]: unknown } => {
    const { result, errors: traitScopeErrors } = scopeResolver.resolveObject(trait);
    for (const scopeErr of traitScopeErrors) {
      traitScopeResolutionFailed = true;
      errors.push({
        appName: app.name,
        stage: "resolve-variables",
        message: service
          ? `${scopeErr.message} (service trait: ${service}/${trait.type})`
          : `${scopeErr.message} (app trait: ${trait.type})`,
        suggestion: scopeErrorSuggestion(scopeErr.scope),
      });
    }
    return result as { type: string; [key: string]: unknown };
  };
  const appTraits = rawAppTraits.map((t) => {
    return resolveTrait(t);
  });

  const serviceTraits: Record<
    string,
    Array<{ type: string; [key: string]: unknown }>
  > = {};
  if (config?.services) {
    for (const [svcName, svcConfig] of Object.entries(config.services)) {
      if (svcConfig.traits && svcConfig.traits.length > 0) {
        serviceTraits[svcName] = (
          svcConfig.traits as Array<{ type: string; [key: string]: unknown }>
        ).map((t) => {
          return resolveTrait(t, svcName);
        });
      }
    }
  }

  // Provider renderers must never receive unresolved scope expressions. Otherwise a
  // missing project setting becomes a late, provider-specific deployment failure.
  if (
    !traitScopeResolutionFailed &&
    (appTraits.length > 0 || Object.keys(serviceTraits).length > 0)
  ) {
    const traitResult = applyTraits({
      appName: app.name,
      compose,
      appTraits,
      serviceTraits,
      registry,
      context: {
        namespace: appNamespace,
        appName: app.name,
        appsDir,
        runtimeFacts,
        // appsDir is $APPBAY_HOME/etc/apps, so the installation root is two levels up.
        // Resolved per app rather than threaded through every call site; the resolver
        // caches per home path, so this is one file read for the whole compile.
        ingressProvider: resolveIngressProvider(join(appsDir, "..", "..")),
      },
    });

    compose = traitResult.compose;
    auxiliaryFiles = traitResult.auxiliaryFiles;
    traitMetadata = traitResult.traitMetadata;
    shepherdActions = traitResult.shepherdActions;

    for (const traitErr of traitResult.errors) {
      const suggestion = traitErr.message.includes("Duplicate")
        ? `Remove the duplicate trait from appbay.yaml. OAM rule: one config per trait type per service.`
        : traitErr.message.includes("Unknown")
          ? `Check trait type spelling. Available: ingress, gpu, auth, hooks, secrets, backup, scoped-env.`
          : traitErr.message.includes("conflicts")
            ? `Remove one of the conflicting traits. See: appbay status ${app.name}`
            : `Run: appbay validate ${app.name} for detailed schema errors.`;
      errors.push({
        appName: app.name,
        stage: "apply-traits",
        message: traitErr.message,
        suggestion,
        details: traitErr.details,
      });
    }

    for (const traitWarn of traitResult.warnings) {
      warnings.push(`[${app.name}] ${traitWarn.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Stage 2d2: Model-init shepherd (auto-pull models on first deploy)
  // -----------------------------------------------------------------------

  if (config?.default_models && config.default_models.length > 0) {
    const models = config.default_models;
    shepherdActions.push({
      phase: "post-deploy" as const,
      label: `Pull default models: ${models.join(", ")}`,
      timeoutMs: 600_000,
      run: async (ctx) => {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);

        // Find the running Ollama container
        const { stdout: psOut } = await execFileAsync(containerBin(), [
          "ps", "--format", "{{.Names}}", "--filter", `name=${ctx.appName}`,
        ], { encoding: "utf-8", timeout: 5_000 });
        const container = psOut.trim().split("\n").filter(Boolean)
          .find((n: string) => n.includes("ollama")) ?? `appbay.${ctx.appName}.${ctx.appName}`;

        // Check if models already exist
        const { stdout: tagResp } = await execFileAsync(containerBin(), [
          "exec", container, "ollama", "list",
        ], { encoding: "utf-8", timeout: 10_000 });
        const existingLines = tagResp.trim().split("\n").filter(Boolean);
        if (existingLines.length > 1) return; // Header + at least one model = skip

        for (const model of models) {
          console.log(`  Pulling default model: ${model}`);
          await execFileAsync(containerBin(), [
            "exec", container, "ollama", "pull", model,
          ], { encoding: "utf-8", timeout: 600_000 });
        }
      },
    });
  }

  // -----------------------------------------------------------------------
  // Stage 2d3: Merge Traefik auxiliary files (cross-trait coordination)
  // -----------------------------------------------------------------------

  auxiliaryFiles = mergeTraefikAuxFiles(auxiliaryFiles);

  // -----------------------------------------------------------------------
  // Stage 2d4: Resolve builds — hoist `build:` out of the render
  // -----------------------------------------------------------------------
  // ⭐ AFTER traits, BEFORE render, and the order is load-bearing in both directions.
  // After traits, because a trait may add or rename a service and the build has to see the
  // final set. Before render, because the whole point is that the RENDERED compose carries
  // no `build:` — deploy becomes "run this image" and the image was produced and CHECKED in
  // a step that already succeeded.
  //
  // ⚠️ Reads the same instance config the ingress provider does, from the same place, for
  // the same reason: `when: {instance: {…}}` asks about the INSTALLATION, not about which
  // other apps happen to be deployed. The overlay `when:` answers that other question and
  // is deliberately not reused here.
  const instanceHome = join(appsDir, "..", "..");
  const buildResult = resolveBuilds(
    compose,
    config?.builds as Record<string, import("../schemas/appbay-yaml.js").BuildSpec> | undefined,
    instanceConfigFor(instanceHome),
  );
  compose = buildResult.compose;
  for (const message of buildResult.errors) {
    errors.push({
      appName: app.name,
      stage: "resolve-builds",
      message,
      suggestion: `Add a builds.<service> entry in ${app.name}/appbay.yaml, or drop the build: block.`,
    });
  }
  for (const build of buildResult.builds) {
    shepherdActions.push(buildShepherdAction(build, join(appsDir, app.name)));
  }

  // -----------------------------------------------------------------------
  // Stage 2e: Render
  // -----------------------------------------------------------------------

  const renderResult = renderCompose({
    appName: app.name,
    compose,
    overrides: config?.overrides as
      | Record<string, Record<string, unknown>>
      | undefined,
    overlayServices:
      Object.keys(overlayServices).length > 0 ? overlayServices : undefined,
    traitCompose: undefined, // Trait modifications are already applied to compose
    auxiliaryFiles,
  });

  // -----------------------------------------------------------------------
  // Stage 2f: Plan
  // -----------------------------------------------------------------------

  let currentCompose: string | null = null;
  const currentPath = join(
    rendersDir,
    app.name,
    "docker-compose.rendered.yml",
  );
  try {
    currentCompose = await readFile(currentPath, "utf-8");
  } catch {
    // File not found means first deploy -- currentCompose stays null.
  }

  const plan = generatePlan({
    appName: app.name,
    rendered: renderResult.compose,
    current: currentCompose,
  });

  // -----------------------------------------------------------------------
  // Stage 2g: Build logical change summary
  // -----------------------------------------------------------------------

  const logicalChanges = buildLogicalChanges({
    appName: app.name,
    appTraits,
    serviceTraits,
    activeOverlays: activeOverlaysForLog,
    planStatus: plan.status,
  });

  return {
    result: {
      appName: app.name,
      rendered: renderResult.compose,
      plan,
      auxiliaryFiles: renderResult.auxiliaryFiles,
      traitMetadata,
      shepherdActions,
      logicalChanges,
    },
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Traefik auxiliary file merger (cross-trait coordination)
// ---------------------------------------------------------------------------

/**
 * Merge Traefik dynamic config files from multiple traits for the same app.
 *
 * When both an ingress trait and an auth trait generate Traefik configs
 * for the same app, this function:
 *   1. Merges the auth middleware definition into the ingress config
 *   2. Adds the auth middleware to each router's middleware list
 *   3. Removes the separate auth file (single file per app is cleaner)
 *
 * Files are identified by path pattern:
 *   - Ingress: etc/apps/traefik/config/dynamic/<app>.yml
 *   - Auth:    etc/apps/traefik/config/dynamic/<app>-auth.yml
 */
function mergeTraefikAuxFiles(
  files: Array<{ path: string; content: string }>,
): Array<{ path: string; content: string }> {
  const traefikDir = "etc/apps/traefik/config/dynamic/";
  const traefikFiles = new Map<string, { path: string; content: string }>();
  const otherFiles: Array<{ path: string; content: string }> = [];

  for (const f of files) {
    if (f.path.startsWith(traefikDir)) {
      traefikFiles.set(basename(f.path), f);
    } else {
      otherFiles.push(f);
    }
  }

  // Find ingress+auth pairs
  const merged = new Set<string>();
  const result = [...otherFiles];

  for (const [filename, ingressFile] of traefikFiles) {
    if (filename.endsWith("-auth.yml")) continue; // handled below
    if (merged.has(filename)) continue;

    const appSlug = filename.replace(/\.yml$/, "");
    const authFilename = `${appSlug}-auth.yml`;
    const authFile = traefikFiles.get(authFilename);

    if (!authFile) {
      result.push(ingressFile);
      continue;
    }

    // Merge: parse both YAML configs, combine middlewares, inject into routers
    try {
      const ingressConfig = parseYaml(ingressFile.content) as Record<string, unknown>;
      const authConfig = parseYaml(authFile.content) as Record<string, unknown>;

      const ingressHttp = (ingressConfig.http ?? {}) as Record<string, unknown>;
      const authHttp = (authConfig.http ?? {}) as Record<string, unknown>;

      // Merge middleware definitions
      const ingressMiddlewares = (ingressHttp.middlewares ?? {}) as Record<string, unknown>;
      const authMiddlewares = (authHttp.middlewares ?? {}) as Record<string, unknown>;
      const allMiddlewares = { ...ingressMiddlewares, ...authMiddlewares };

      // Find auth middleware names (from the auth config)
      const authMiddlewareNames = Object.keys(authMiddlewares);

      // Inject auth middleware into each router's middleware list
      const routers = { ...((ingressHttp.routers ?? {}) as Record<string, unknown>) };
      for (const [routerName, routerConfig] of Object.entries(routers)) {
        const router = { ...(routerConfig as Record<string, unknown>) };
        const existing = (router.middlewares ?? []) as string[];
        router.middlewares = [...authMiddlewareNames, ...existing];
        routers[routerName] = router;
      }

      const mergedConfig = {
        http: {
          ...ingressHttp,
          middlewares: allMiddlewares,
          routers,
        },
      };

      result.push({
        path: ingressFile.path,
        content: stringifyYaml(mergedConfig, { sortMapEntries: true }),
      });
      merged.add(filename);
      merged.add(authFilename);
    } catch {
      // Parse error — keep both files as-is
      result.push(ingressFile);
      result.push(authFile);
      merged.add(filename);
      merged.add(authFilename);
    }
  }

  // Add any unmerged auth files
  for (const [filename, file] of traefikFiles) {
    if (!merged.has(filename)) {
      result.push(file);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Logical change summary builder
// ---------------------------------------------------------------------------

/** Convert a WhenClause to a readable string label. */
export function whenClauseLabel(when: ActiveOverlay["when"]): string {
  if (Array.isArray(when)) {
    return `when: ${when.join(" + ")}`;
  }
  return `any: ${when.any.join(" | ")}`;
}

/**
 * Build logical change groups from the compiled pipeline outputs.
 * Groups app-level traits and overlays together, then adds per-service
 * groups for service-level traits.
 */
function buildLogicalChanges(params: {
  appName: string;
  appTraits: Array<{ type: string; [key: string]: unknown }>;
  serviceTraits: Record<string, Array<{ type: string; [key: string]: unknown }>>;
  activeOverlays: ActiveOverlay[];
  planStatus: "new" | "changed" | "unchanged" | "removed";
}): LogicalGroup[] {
  const { appName, appTraits, serviceTraits, activeOverlays, planStatus } = params;
  const groups: LogicalGroup[] = [];

  // App-level group: collect app traits + overlay activations
  const appChanges: LogicalChangeEntry[] = [];

  // First-deploy or removal markers
  if (planStatus === "new") {
    appChanges.push({
      type: "image",
      op: "+",
      text: appName,
      detail: "First deployment — no previous state on disk",
    });
  } else if (planStatus === "removed") {
    appChanges.push({
      type: "image",
      op: "-",
      text: appName,
      detail: "App removed from configuration",
    });
  }

  // App-level traits
  for (const t of appTraits) {
    appChanges.push({
      type: "trait",
      op: "+",
      text: t.type,
      detail: "App-level trait applied",
    });
  }

  // Active overlays
  for (const overlay of activeOverlays) {
    const affectedServices = Object.keys(overlay.services);
    const svcList = affectedServices.length > 0
      ? `affects: ${affectedServices.join(", ")}`
      : "no services modified";
    appChanges.push({
      type: "overlay",
      op: "+",
      text: whenClauseLabel(overlay.when),
      detail: `Overlay activated · ${svcList}`,
    });
  }

  if (appChanges.length > 0) {
    groups.push({ app: appName, svc: "", changes: appChanges });
  }

  // Service-level groups: one group per service that has traits
  for (const [svcName, traits] of Object.entries(serviceTraits)) {
    const svcChanges: LogicalChangeEntry[] = traits.map((t) => ({
      type: "trait" as const,
      op: "+" as const,
      text: t.type,
      detail: `Service-level trait applied to ${svcName}`,
    }));
    if (svcChanges.length > 0) {
      groups.push({ app: appName, svc: svcName, changes: svcChanges });
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Magic variable resolution
// ---------------------------------------------------------------------------

/**
 * Walk a compose object and resolve magic variable patterns in string values.
 * ${password:16}, ${uuid}, ${base64:32} → generated and persisted.
 * ${hash} → deterministic, no persistence.
 * ${timestamp} → current time, no persistence.
 * Regular ${VAR} Docker Compose syntax is left untouched.
 */
async function resolveMagicVars(
  compose: Record<string, unknown>,
  store: GeneratedValueStore,
  namespace: string,
  appName: string,
): Promise<Record<string, unknown>> {
  const result = structuredClone(compose);
  const services = (result.services ?? {}) as Record<string, Record<string, unknown>>;

  for (const [svcName, svc] of Object.entries(services)) {
    if (!Array.isArray(svc.environment)) continue;

    const resolvedEnv: string[] = [];
    for (const entry of svc.environment as string[]) {
      const eq = entry.indexOf("=");
      if (eq <= 0) {
        resolvedEnv.push(entry);
        continue;
      }

      const key = entry.substring(0, eq);
      const value = entry.substring(eq + 1);
      const parsed = parseMagicVar(value);

      if (!parsed) {
        resolvedEnv.push(entry);
        continue;
      }

      // Resolve the magic variable
      const storeKey = { namespace, service: svcName, varName: key };
      const resolved = await store.getOrCreate(storeKey, `${parsed.type}${parsed.arg ? `:${parsed.arg}` : ""}`);
      resolvedEnv.push(`${key}=${resolved}`);
    }

    svc.environment = resolvedEnv;
  }

  return result;
}

/**
 * Read $APPBAY_HOME/project.yaml for the build `when:` predicate.
 *
 * ⚠️ Returns {} rather than throwing on a missing or unparseable file. An uninitialised
 * install must still be able to compile — `appbay validate` on a checkout is a legitimate
 * thing to do, and a gated build simply does not apply when there is no config to match.
 */
function instanceConfigFor(appbayHome: string): Record<string, unknown> {
  try {
    return parseInstanceConfig(
      readFileSync(join(appbayHome, "project.yaml"), "utf-8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}
