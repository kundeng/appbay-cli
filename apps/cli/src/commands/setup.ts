/**
 * `appbay setup` — guided setup wizard.
 *
 * Orchestrates the full journey from "binary installed" to "working Appbay
 * with the selected supported edge running. Calls `init` internally, then
 * initializes the vault and deploys either Traefik or integrated Caddy Security.
 *
 * Non-interactive mode: `appbay setup --domain X --project Y --ingress-provider caddy --yes`
 */

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { selfInvocation } from "../utils/self.js";
import { stopApps } from "./down.js";
import { ask } from "../utils/prompt.js";
import {
  resolveIngressProvider,
  resolveAcmeDnsProvider,
  clearContainerRuntimeCache,
  type AcmeDnsProvider,
  SHARED_NETWORK, checkNetwork, runtimeProfile, containerBin } from "@appbay/core";
import { SYSTEM_CONFIG_REL, LEGACY_INSTANCE_CONFIG_REL, findContainerByLabel, APP_LABEL, networkExists, containerExec } from "@appbay/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function step(n: number, total: number, msg: string): void {
  console.log(`\n  [${n}/${total}] ${msg}`);
}

function detectPlatform(): { os: string; docker: string } {
  const platform = process.platform === "darwin" ? "macOS" : "Linux";
  const appbayHome = resolveAppbayHome();
  const runtimeName = runtimeProfile(appbayHome).displayName;

  // The context name tells a desktop distribution apart; the runtime's own name is the default.
  const result = containerExec(["context", "inspect", "--format", "{{.Name}}"], { appbayHome, timeout: 10_000 });
  const context = result.exitCode === 0 ? result.output.trim() : "";

  let docker = runtimeName;
  if (context.includes("orbstack") || context.includes("colima")) {
    docker = context.includes("orbstack") ? "OrbStack" : "Colima";
  } else if (platform === "macOS" && runtimeName === "Docker") {
    docker = "Docker Desktop";
  }

  return { os: platform, docker };
}

function validateDocker(): boolean {
  return containerExec(["info"], { appbayHome: resolveAppbayHome(), timeout: 10_000 }).exitCode === 0;
}

function validateCompose(): boolean {
  return containerExec(["compose", "version"], { appbayHome: resolveAppbayHome(), timeout: 10_000 }).exitCode === 0;
}

// ---------------------------------------------------------------------------
// Traefik config scaffolding
// ---------------------------------------------------------------------------

function scaffoldTraefikConfig(
  appbayHome: string,
  opts: { domain: string; acmeEmail?: string },
): void {
  const traefikDir = join(appbayHome, "etc", "apps", "traefik");
  const configDir = join(traefikDir, "config");
  const dynamicDir = join(configDir, "dynamic");

  // 🚨 DO NOT bail on `traefik.yml` existing. `appbay init` seeds the traefik system
  // app — including its static config — so on every real install this file is already
  // there by the time setup runs. An early return here skipped EVERYTHING below,
  // including self-signed certificate generation, and setup still printed "Traefik
  // config ready". The result was an edge that could not complete a TLS handshake on
  // any local domain while every command reported success.
  //
  // Each artifact below decides for itself whether it needs writing.
  const staticConfigExists = existsSync(join(configDir, "traefik.yml"));

  mkdirSync(dynamicDir, { recursive: true });

  // Static config
  const staticConfig: Record<string, unknown> = {
    api: { dashboard: true, insecure: true },
    entryPoints: {
      web: {
        address: ":80",
        http: { redirections: { entryPoint: { to: "websecure", scheme: "https" } } },
      },
      websecure: { address: ":443" },
    },
    providers: {
      file: { directory: "/config/dynamic", watch: true },
    },
  };

  if (opts.acmeEmail) {
    staticConfig.certificatesResolvers = {
      letsencrypt: {
        acme: {
          email: opts.acmeEmail,
          storage: "/config/acme.json",
          httpChallenge: { entryPoint: "web" },
        },
      },
    };
  }

  // ⚠️ Preserve an existing static config — an operator may have tuned it, and the
  // seeded one from `appbay init` is already correct. Only the TLS material below is
  // unconditional, because that is what was silently missing.
  if (!staticConfigExists) {
    writeFileSync(join(configDir, "traefik.yml"), stringifyYaml(staticConfig));
  }

  // Create acme.json with correct permissions
  const acmePath = join(configDir, "acme.json");
  writeFileSync(acmePath, "", { flag: "a" });
  chmodSync(acmePath, 0o600);

  // Default redirect middleware (HTTP → HTTPS)
  const redirectConfig = {
    http: {
      middlewares: {
        "redirect-to-https": {
          redirectScheme: { scheme: "https", permanent: true },
        },
      },
    },
  };
  writeFileSync(join(dynamicDir, "redirect.yml"), stringifyYaml(redirectConfig));

  // Generate self-signed wildcard cert for local domains
  const isLocalDomain = /\.(local|lan|internal|test|localhost)$/i.test(opts.domain);
  if (isLocalDomain) {
    const certsDir = join(traefikDir, "certs");
    const certFile = join(certsDir, "local.crt");
    const keyFile = join(certsDir, "local.key");
    mkdirSync(certsDir, { recursive: true });

    // ⚠️ The certs directory is a bind-mount target. If the edge container started
    // before setup ran, Docker created this path as root:root, and `openssl` writing
    // as the operator gets EACCES. `mkdir -p` still succeeds because the directory
    // exists, so the failure lands entirely on openssl.
    if (!existsSync(certFile) || !existsSync(keyFile)) {
      const gen = spawnSync("openssl", [
        "req", "-x509", "-nodes", "-days", "3650",
        "-newkey", "rsa:2048",
        "-keyout", keyFile,
        "-out", certFile,
        "-subj", `/CN=*.${opts.domain}`,
        "-addext", `subjectAltName=DNS:*.${opts.domain},DNS:${opts.domain}`,
      ], { encoding: "utf-8" });

      // 🚨 FAIL LOUDLY. This used to ignore the result entirely: a missing openssl or
      // an unwritable directory produced no certificate, no error, and a cheerful
      // "Traefik config ready" — followed by every HTTPS request dying with
      // `tlsv1 unrecognized name`, because tls-options.yml sets sniStrict.
      if (gen.status !== 0 || !existsSync(certFile) || !existsSync(keyFile)) {
        const detail = gen.error?.message ?? gen.stderr?.trim() ?? `exit ${String(gen.status)}`;
        throw new Error(
          `Failed to generate the self-signed certificate for ${opts.domain}.\n` +
            `  ${detail}\n` +
            `  Target: ${certsDir}\n` +
            `  If that directory is owned by root, the edge container created it first. Fix with:\n` +
            `    sudo chown -R "$(id -u):$(id -g)" ${certsDir}\n` +
            `  Then re-run setup. Without this certificate every HTTPS request to a\n` +
            `  ${opts.domain} host fails the TLS handshake.`,
        );
      }
    }

    const tlsConfig = {
      tls: {
        certificates: [{ certFile: "/certs/local.crt", keyFile: "/certs/local.key" }],
        stores: {
          default: {
            defaultCertificate: { certFile: "/certs/local.crt", keyFile: "/certs/local.key" },
          },
        },
      },
    };
    writeFileSync(join(dynamicDir, "tls-default.yml"), stringifyYaml(tlsConfig));
  }
}

// ---------------------------------------------------------------------------
// ACME DNS-01 — the whole path, or none of it
// ---------------------------------------------------------------------------

/**
 * The per-site `tls` snippet for a DNS-01 provider.
 *
 * 🚨 PER-SITE, NEVER GLOBAL. Caddy SILENTLY IGNORES a global `acme_dns` block: the config
 * loads without complaint and certificates simply never issue by DNS. The ingress trait
 * therefore emits `import /etc/caddy/tls/*.caddy` into each site block, and this file is
 * what that glob matches.
 *
 * ⚠️ The token is `{env.…}`, resolved by Caddy at runtime from the process env the secrets
 * trait injects — not written here. `docker compose config` prints file contents in
 * cleartext; it does not print what the deploying process injected.
 */
function acmeDnsSnippet(provider: AcmeDnsProvider, resolvers?: string): string {
  const lines = [
    "# Generated by Appbay — do not edit manually.",
    "# Imported into every site block emitted by the ingress trait.",
    "tls {",
    `\tdns ${provider} {env.${provider.toUpperCase()}_API_TOKEN}`,
  ];
  if (resolvers && resolvers.trim()) {
    // 🚨 REQUIRED WHERE EGRESS BLOCKS OUTBOUND :53, AND THE FAILURE IS BAFFLING WITHOUT IT.
    // certmagic pre-checks DNS-01 propagation by querying the zone's AUTHORITATIVE
    // nameservers directly. Where a network blocks outbound 53 to external resolvers that
    // check times out forever and no certificate ever issues — even though the TXT record
    // was written successfully through the provider API. Point the check at resolvers the
    // host can actually reach.
    // ⚠️ Emitted ONLY when configured. An empty `resolvers` token is a PARSE ERROR, not a
    // harmless default — the same shape as the `email {$ACME_EMAIL}` failure that once
    // stopped a fresh install from starting at all.
    lines.push(`\tresolvers ${resolvers.trim()}`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// System app deployment with health gates
// ---------------------------------------------------------------------------

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const healthy = await fetch(url, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok).catch(() => false);
    if (healthy) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

async function waitForEdge(provider: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Caddy's admin endpoint is container-local, so the contract here is process
    // availability: the edge, found by its label, reports state "running".
    if (await edgeIsRunning(provider)) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

/** The edge is found by label, not by name: the system namespace is in the name. */
async function edgeIsRunning(provider: string): Promise<boolean> {
  const edge = await findContainerByLabel(APP_LABEL, provider);
  return edge.kind === "ok" && edge.value?.running === true;
}

/** The edge's state for a decision that must not proceed over an unanswered runtime. */
async function edgeState(provider: string, appbayHome: string): Promise<"running" | "not-running" | { unknown: string }> {
  const edge = await findContainerByLabel(APP_LABEL, provider, { appbayHome });
  if (edge.kind === "unknown") return { unknown: edge.reason };
  return edge.value?.running ? "running" : "not-running";
}

// ---------------------------------------------------------------------------
// Status subcommand
// ---------------------------------------------------------------------------

async function showSetupStatus(): Promise<void> {
  let appbayHome: string;
  try {
    appbayHome = resolveAppbayHome();
  } catch {
    console.log("  Setup Status: NOT STARTED\n");
    console.log("  Run 'appbay setup' to begin.");
    return;
  }

  console.log("  Setup Status\n");

  const ingressProvider = resolveIngressProvider(appbayHome);
  const edgeApp = join(appbayHome, "etc", "apps", ingressProvider);

  const checks = [
    { name: "APPBAY_HOME", ok: existsSync(appbayHome), detail: appbayHome },
    { name: "Shared network", ok: (await checkNetwork(appbayHome)).status === "ok", detail: SHARED_NETWORK },
    { name: "Selected edge seeded", ok: existsSync(edgeApp), detail: ingressProvider },
    { name: "Selected edge running", ok: await edgeIsRunning(ingressProvider), detail: ingressProvider },
    ...(ingressProvider === "caddy" ? [{
      name: "Caddy Security identities",
      ok: existsSync(join(edgeApp, "config", "security", "users.json")),
      detail: "config/security/users.json",
    }] : []),
    { name: "Server compose", ok: existsSync(join(appbayHome, "docker-compose.server.yml")), detail: "docker-compose.server.yml" },
    {
      name: "Instance config",
      // Either location counts — an install that predates RFC-001 §2.1 is still configured.
      ok:
        existsSync(join(appbayHome, SYSTEM_CONFIG_REL)) ||
        existsSync(join(appbayHome, LEGACY_INSTANCE_CONFIG_REL)),
      detail: SYSTEM_CONFIG_REL,
    },
  ];

  for (const c of checks) {
    const icon = c.ok ? "✓" : "✗";
    console.log(`  ${icon} ${c.name}: ${c.ok ? c.detail : "MISSING"}`);
  }

  const done = checks.filter((c) => c.ok).length;
  const total = checks.length;
  console.log(`\n  ${done}/${total} complete.`);

  if (done < total) {
    console.log("  Run 'appbay setup' to complete missing steps.");
  } else {
    console.log("  Setup is fully complete.");
  }
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

async function resetSetup(): Promise<void> {
  let appbayHome: string;
  try {
    appbayHome = resolveAppbayHome();
  } catch {
    console.log("  Nothing to reset — APPBAY_HOME not found.");
    return;
  }

  console.log(`  Resetting Appbay at ${appbayHome}\n`);

  // Every app stops through the one stop path, from the render each was started from,
  // because every render is about to go; a failed stop aborts the reset rather than
  // deleting a render out from under a running container, which would leave it with no
  // command that reaches it.
  try {
    const stop = await stopApps(appbayHome, []);
    if (stop.failed > 0) throw new Error("an app did not stop");
  } catch (err) {
    console.error(`  Reset aborted: ${err instanceof Error ? err.message : String(err)}; nothing was removed.`);
    process.exit(1);
  }
  // A render that is already gone is skipped by stopApps; the edge itself may still run.
  for (const provider of ["caddy", "traefik"]) {
    const state = await edgeState(provider, appbayHome);
    if (state === "not-running") continue;
    console.error(state === "running"
      ? `  Reset aborted: the ${provider} edge is still running and its render is not here to stop it. Stop it by hand (\`${containerBin(appbayHome)} ps\`), then re-run.`
      : `  Reset aborted: could not ask the runtime whether the ${provider} edge runs (${state.unknown}).`);
    process.exit(1);
  }
  if (existsSync(join(appbayHome, "docker-compose.server.yml"))) {
    const server = containerExec(["compose", "-f", join(appbayHome, "docker-compose.server.yml"), "down"], { appbayHome, cwd: appbayHome, timeout: 120_000 });
    if (server.exitCode !== 0) {
      console.error(`  Reset aborted: the server did not stop: ${server.output.trim()}`);
      process.exit(1);
    }
  }

  // Remove generated configs (keep app definitions and vault)
  // Docker containers may own some files, so use docker run for cleanup
  const toRemove = [
    "etc/apps/traefik/config",
    "etc/apps/caddy/config/security/users.json",
    "var/lib/renders",
    "var/cache",
    "docker-compose.server.yml",
    "project.yaml",
  ];

  for (const rel of toRemove) {
    const p = join(appbayHome, rel);
    if (existsSync(p)) {
      // Try native rm first, fall back to docker for root-owned files
      try {
        await rm(p, { recursive: true, force: true });
      } catch {
        const removed = containerExec(["run", "--rm", "-v", `${appbayHome}:/appbay`, "alpine", "rm", "-rf", `/appbay/${rel}`], { appbayHome, timeout: 60_000 });
        if (removed.exitCode !== 0) {
          console.error(`  Could not remove $APPBAY_HOME/${rel}: ${removed.output.trim()}`);
          process.exit(1);
        }
      }
      console.log(`  Removed $APPBAY_HOME/${rel}`);
    }
  }

  console.log("\n  Reset complete. Run 'appbay setup' to re-initialize.");
}

// ---------------------------------------------------------------------------
// Main setup command
// ---------------------------------------------------------------------------

export const setupCommand = new Command("setup")
  .description("Guided setup: init → vault → selected edge")
  .option("--domain <domain>", "base domain for ingress routing")
  .option("--project <name>", "project name")
  .option("--email <email>", "ACME email for Let's Encrypt")
  .option("--ingress-provider <provider>", 'supported edge: "traefik" or "caddy"')
  .option("--yes", "non-interactive mode")
  .option("--status", "show setup status without running setup")
  .option("--reset", "stop every app, remove the generated configuration and renders, and keep app definitions and the vault")
  .action(async (options: {
    domain?: string;
    project?: string;
    status?: boolean;
    reset?: boolean;
    email?: string;
    ingressProvider?: string;
    yes?: boolean;
  }) => {
    if (options.status) {
      await showSetupStatus();
      return;
    }

    if (options.reset) {
      await resetSetup();
      return;
    }

    const isInteractive = !options.yes && process.stdin.isTTY;
    const totalSteps = 6;

    console.log("\n  Appbay Setup\n");

    // ── Step 1: Platform detection & Docker validation ─────────────────────
    step(1, totalSteps, "Checking prerequisites...");

    const platform = detectPlatform();
    console.log(`    Platform: ${platform.os} (${platform.docker})`);

    const runtimeName = runtimeProfile(resolveAppbayHome()).displayName;
    if (!validateDocker()) {
      console.error(`\n  ERROR: ${runtimeName} is not accessible.`);
      console.error(`  Make sure ${runtimeName} is installed and running.`);
      process.exit(1);
    }
    console.log(`    ${runtimeName}: accessible`);

    if (!validateCompose()) {
      console.error(`\n  ERROR: ${runtimeName} compose is not available.`);
      console.error("  Appbay requires the compose v2 plugin (`docker compose` / `podman compose`).");
      process.exit(1);
    }
    console.log("    Compose: available");

    // ── Step 2: Gather config (project name, domain, email) ───────────────
    step(2, totalSteps, "Configuration...");

    let projectName = options.project ?? "";
    let domain = options.domain ?? "";
    let acmeEmail = options.email ?? "";

    if (isInteractive) {
      if (!projectName) {
        const hostname = (() => {
          const r = spawnSync("hostname", ["-s"], { stdio: "pipe", encoding: "utf-8" });
          return r.status === 0 ? String(r.stdout).trim() || "homelab" : "homelab";
        })();
        projectName = await ask("    Project name", hostname);
      }
      if (!domain) {
        domain = await ask("    Base domain", "local");
      }
      if (!acmeEmail && domain !== "local" && domain !== "localhost") {
        acmeEmail = await ask("    ACME email (for Let's Encrypt, blank to skip)", "");
      }
    }

    if (!projectName) projectName = "homelab";
    if (!domain) domain = "local";

    console.log(`    Project: ${projectName}`);
    console.log(`    Domain:  ${domain}`);
    if (acmeEmail) console.log(`    Email:   ${acmeEmail}`);

    // ── Step 3: Run init (scaffold + network + system apps + catalog) ──────
    step(3, totalSteps, "Initializing...");

    const self = selfInvocation();
    const binaryPath = self.bin;

    const initArgs = ["init", "--project", projectName, "--domain", domain, "--yes"];
    if (options.ingressProvider) initArgs.push("--ingress-provider", options.ingressProvider);
    const initResult = spawnSync(binaryPath, [...self.args, ...initArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    // `init` is idempotent on an initialised home (it reports the existing project config
    // and continues), so a non-zero exit is a failure and nothing in its text is parsed.
    if (initResult.status !== 0) {
      const stderr = initResult.stderr ? String(initResult.stderr) : "";
      console.error(`    Init failed: ${stderr || "unknown error"}`);
      console.error("    Run 'appbay init' separately to diagnose.");
      process.exit(1);
    }
    console.log("    Scaffold ready.");

    const appbayHome = resolveAppbayHome();
    // Prerequisite checks resolve the runtime before init writes project.yaml, which caches
    // an empty instance config. Drop it so this same process sees the selected edge.
    clearContainerRuntimeCache(appbayHome);

    // ── Step 4: Initialize vault ──────────────────────────────────────────
    step(4, totalSteps, "Initializing secrets vault...");

    const vaultArgs = ["secrets", "init"];
    const vaultResult = spawnSync(binaryPath, [...self.args, ...vaultArgs], {
      stdio: isInteractive ? "inherit" : ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    if (vaultResult.status === 0) {
      console.log("    Vault initialized.");
    } else if (existsSync(join(appbayHome, "var", "lib", "vault.enc"))) {
      console.log("    Vault already initialized.");
    } else {
      console.error("    Vault initialization failed.");
      console.error("    Non-interactive setup requires APPBAY_VAULT_PASSWORD.");
      process.exit(1);
    }

    // ── Step 5: Scaffold the configured ingress ───────────────────────────
    const ingressProvider = resolveIngressProvider(appbayHome);
    step(5, totalSteps, `Scaffolding ${ingressProvider} config...`);

    if (ingressProvider === "traefik") {
      scaffoldTraefikConfig(appbayHome, { domain, acmeEmail: acmeEmail || undefined });
      console.log("    Traefik config ready.");
    } else {
      // Caddy's per-app site blocks are emitted by the ingress trait at compile time, and
      // the caddy system app ships its own Caddyfile with the `import` globs that pick them
      // up. There is no equivalent of Traefik's dynamic-config scaffold to write here — the
      // absence is the design, not an omission.
      console.log("    Caddy needs no scaffold — site blocks are emitted per app by the");
      console.log("    ingress trait, and the caddy app ships the Caddyfile that imports them.");

      // ---- ACME DNS-01, if this installation uses it ----------------------
      // ⚠️ Absent is a real answer, not a missing one: no DNS-01 means HTTP-01 for public
      // names and the internal issuer for everything else, which is correct for a laptop
      // install and wrong for a host that is not reachable from the internet on :80.
      const dnsProvider = resolveAcmeDnsProvider(appbayHome);
      if (dnsProvider) {
        const tlsDir = join(appbayHome, "etc", "apps", "caddy", "config", "tls");
        await mkdir(tlsDir, { recursive: true });
        const snippetPath = join(tlsDir, `dns01-${dnsProvider}.caddy`);
        const snippet = acmeDnsSnippet(dnsProvider, process.env.APPBAY_ACME_DNS_RESOLVERS);
        // ⚠️ CONTENT-AWARE, so "changed" means changed. A blind write made every converge
        // report a change, which costs nothing here but destroys the one signal that says a
        // configuration-managed host has settled — `changed=0` on a second run.
        const existingSnippet = await readFile(snippetPath, "utf-8").catch(() => null);
        if (existingSnippet !== snippet) {
          await writeFile(snippetPath, snippet, "utf-8");
          console.log(`    Wrote ${dnsProvider} DNS-01 snippet.`);
        } else {
          console.log(`    ${dnsProvider} DNS-01 snippet already current.`);
        }

        // ⛔ NO BUILD HERE, DELIBERATELY. Producing the image is the BUILD STAGE's job
        // (compiler/builds.ts), declared in the caddy stack's own appbay.yaml and run as a
        // pre-deploy action. Doing it here would mean `appbay up caddy` on day 2 never
        // builds, no other app could ever declare a build, and the caddy stack would not
        // state its own requirement — which is the special case this was moved out of.
      }
    }

    // ── Step 6: Deploy the selected edge through AppBay's compiler ────────
    step(6, totalSteps, `Deploying ${ingressProvider}...`);
    const edgeUsersPath = join(appbayHome, "etc", "apps", "caddy", "config", "security", "users.json");
    const firstCaddyStart = ingressProvider === "caddy" && !existsSync(edgeUsersPath);
    const deployResult = spawnSync(binaryPath, [...self.args, "up", ingressProvider], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      encoding: "utf-8",
    });
    if (deployResult.status !== 0) {
      console.error(`\n  Setup failed during ${ingressProvider} deployment.`);
      console.error(String(deployResult.stderr || deployResult.stdout || "unknown deployment error").trim());
      process.exit(1);
    }
    process.stdout.write(String(deployResult.stdout));
    // The deploy's exit code says it ran; the edge running is what setup promised.
    const edgeUp = await findContainerByLabel(APP_LABEL, ingressProvider, { appbayHome });
    if (edgeUp.kind === "unknown" || !edgeUp.value?.running) {
      const why = edgeUp.kind === "unknown" ? edgeUp.reason : edgeUp.value ? `it is ${edgeUp.value.state}` : "no container carries its label";
      console.error(`\n  Setup failed: the ${ingressProvider} edge is not running after its deploy (${why}).`);
      process.exit(1);
    }

    if (ingressProvider === "traefik") {
        console.log("    Waiting for Traefik health...");
        const healthy = await waitForHealth("http://localhost:8080/api/overview", 30_000);
        if (!healthy) {
          console.error("    Traefik health check failed.");
          process.exit(1);
        } else {
          console.log("    Traefik healthy.");
        }
    } else {
        // ⚠️ Caddy's admin API is bound to localhost INSIDE the container, so there is no
        // host-side URL to poll the way Traefik's :8080 dashboard offers. The container's own
        // state is the available signal — and it is the honest one, since "the process is up"
        // is exactly what this gate is for.
        console.log("    Waiting for Caddy health...");
        const healthy = await waitForEdge("caddy", 60_000);
        if (!healthy) {
          console.error("    Caddy health check failed.");
          process.exit(1);
        } else {
          console.log("    Caddy healthy.");
        }
        if (firstCaddyStart && healthy) {
          // ⚠️ "admin" here is CADDY SECURITY'S OWN bootstrap edge user, created on first
          // start with a generated password — NOT the AppBay control-plane account of the
          // same name. They are separate credential domains and are never synchronized.
          // Rotating this one does not touch `appbay admin`.
          console.log("    Rotating the generated bootstrap EDGE administrator password...");
          const reset = spawnSync(binaryPath, [...self.args, "edge", "users", "reset-password", "admin", "--generate", "--reveal"], {
            stdio: ["pipe", "pipe", "pipe"], env: process.env, encoding: "utf-8",
          });
          // The password is on stdout whatever the restart did; it is the deliverable, so it is
          // written before the status is judged.
          process.stdout.write(String(reset.stdout));
          if (reset.status !== 0) {
            console.error(String(reset.stderr || "Unable to initialize the edge administrator password.").trim());
            process.exit(1);
          }
        }
    }

    // ── Summary ───────────────────────────────────────────────────────────
    console.log("\n  ─────────────────────────────────────────────────────");
    console.log("  Setup complete!\n");
    console.log(`    Data directory:  ${appbayHome}`);
    console.log(`    Domain:          ${domain}`);
    console.log(`    Edge:            ${ingressProvider === "caddy" ? "Caddy + Caddy Security" : "Traefik (ingress only)"}`);

    console.log("\n  Next steps:");
    console.log("    appbay server start       Start the control plane");
    console.log("    appbay catalog list        Browse available apps");
    console.log("    appbay install <app>       Install an app from catalog");
    console.log("    appbay up <app>            Deploy an app");
    console.log("");
  });
