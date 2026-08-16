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
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { ask } from "../utils/prompt.js";
import {
  resolveIngressProvider,
  resolveAcmeDnsProvider,
  clearContainerRuntimeCache,
  type AcmeDnsProvider,
} from "@appbay/core";
import { cliContainerBin } from "../utils/docker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function step(n: number, total: number, msg: string): void {
  console.log(`\n  [${n}/${total}] ${msg}`);
}

function run(cmd: string, args: string[], opts?: { silent?: boolean }): boolean {
  const result = spawnSync(cmd, args, {
    stdio: opts?.silent ? ["pipe", "pipe", "pipe"] : ["pipe", "inherit", "inherit"],
  });
  return result.status === 0;
}

function detectPlatform(): { os: string; docker: string } {
  const platform = process.platform === "darwin" ? "macOS" : "Linux";

  // Detect Docker runtime
  const result = spawnSync(cliContainerBin(), ["context", "inspect", "--format", "{{.Name}}"], {
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
  });
  const context = result.status === 0 ? String(result.stdout).trim() : "";

  let docker = "Docker Engine";
  if (context.includes("orbstack") || context.includes("colima")) {
    docker = context.includes("orbstack") ? "OrbStack" : "Colima";
  } else if (platform === "macOS") {
    docker = "Docker Desktop";
  }

  return { os: platform, docker };
}

function validateDocker(): boolean {
  const result = spawnSync(cliContainerBin(), ["info"], { stdio: ["pipe", "pipe", "pipe"] });
  return result.status === 0;
}

function validateCompose(): boolean {
  const result = spawnSync(cliContainerBin(), ["compose", "version"], { stdio: ["pipe", "pipe", "pipe"] });
  return result.status === 0;
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

  // Create directories
  spawnSync("mkdir", ["-p", dynamicDir]);

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
    const staticYaml = stringifyYaml(staticConfig);
    spawnSync("bash", ["-c", `cat > "${join(configDir, "traefik.yml")}" << 'EOF'\n${staticYaml}EOF`]);
  }

  // Create acme.json with correct permissions
  const acmePath = join(configDir, "acme.json");
  spawnSync("touch", [acmePath]);
  spawnSync("chmod", ["600", acmePath]);

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
  const redirectYaml = stringifyYaml(redirectConfig);
  spawnSync("bash", ["-c", `cat > "${join(dynamicDir, "redirect.yml")}" << 'EOF'\n${redirectYaml}EOF`]);

  // Generate self-signed wildcard cert for local domains
  const isLocalDomain = /\.(local|lan|internal|test|localhost)$/i.test(opts.domain);
  if (isLocalDomain) {
    const certsDir = join(traefikDir, "certs");
    const certFile = join(certsDir, "local.crt");
    const keyFile = join(certsDir, "local.key");
    spawnSync("mkdir", ["-p", certsDir]);

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
    const tlsYaml = stringifyYaml(tlsConfig);
    spawnSync("bash", ["-c", `cat > "${join(dynamicDir, "tls-default.yml")}" << 'EOF'\n${tlsYaml}EOF`]);
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

function waitForHealth(url: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync("curl", ["-sf", "--max-time", "2", url], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status === 0) return true;
    spawnSync("sleep", ["2"]);
  }
  return false;
}

function waitForContainerHealth(containerName: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Caddy's admin endpoint is intentionally container-local, so setup's contract here is
    // process availability. `.State.Running` is shared by Docker and Podman; Docker's nested
    // `.State.Health` template is rejected by Podman 4.9 before it can evaluate the fallback.
    if (containerIsRunning(containerName)) return true;
    spawnSync("sleep", ["3"]);
  }
  return false;
}

function containerIsRunning(containerName: string): boolean {
  const result = spawnSync(cliContainerBin(), [
    "inspect", "--format", "{{.State.Running}}", containerName,
  ], { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" });
  return result.status === 0 && String(result.stdout).trim() === "true";
}

// ---------------------------------------------------------------------------
// Status subcommand
// ---------------------------------------------------------------------------

function showSetupStatus(): void {
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
    { name: "Docker network", ok: (() => { const r = spawnSync(cliContainerBin(), ["network", "inspect", "appbay_shared"], { stdio: "pipe" }); return r.status === 0; })(), detail: "appbay_shared" },
    { name: "Selected edge seeded", ok: existsSync(edgeApp), detail: ingressProvider },
    { name: "Selected edge running", ok: containerIsRunning(`appbay.${ingressProvider}.${ingressProvider}`) || containerIsRunning(`appbay.${ingressProvider}`), detail: ingressProvider },
    ...(ingressProvider === "caddy" ? [{
      name: "Caddy Security identities",
      ok: existsSync(join(edgeApp, "config", "security", "users.json")),
      detail: "config/security/users.json",
    }] : []),
    { name: "Server compose", ok: existsSync(join(appbayHome, "docker-compose.server.yml")), detail: "docker-compose.server.yml" },
    { name: "Project config", ok: existsSync(join(appbayHome, "project.yaml")), detail: "project.yaml" },
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

  // Stop system app containers
  for (const name of ["caddy", "traefik"]) {
    const appDir = join(appbayHome, "etc", "apps", name);
    if (existsSync(join(appDir, "docker-compose.yml"))) {
      console.log(`  Stopping ${name}...`);
      spawnSync(cliContainerBin(), ["compose", "-f", join(appDir, "docker-compose.yml"), "down"], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: appDir,
      });
    }
  }

  // Stop server
  spawnSync(cliContainerBin(), ["compose", "-f", join(appbayHome, "docker-compose.server.yml"), "down"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: appbayHome,
  });

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
        spawnSync(cliContainerBin(), ["run", "--rm", "-v", `${appbayHome}:/appbay`, "alpine", "rm", "-rf", `/appbay/${rel}`], {
          stdio: ["pipe", "pipe", "pipe"],
        });
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
  .option("--reset", "tear down system apps and remove generated configs")
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
      showSetupStatus();
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

    if (!validateDocker()) {
      console.error("\n  ERROR: Docker is not accessible.");
      console.error("  Make sure Docker is installed and running.");
      process.exit(1);
    }
    console.log("    Docker: accessible");

    if (!validateCompose()) {
      console.error("\n  ERROR: Docker Compose v2 not found.");
      console.error("  Appbay requires `docker compose` (v2 plugin).");
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

    // Find the appbay binary path — process.argv[0] is unreliable in bun-compiled binaries
    const binaryPath = (() => {
      const which = spawnSync("which", ["appbay"], { stdio: "pipe", encoding: "utf-8" });
      if (which.status === 0) return which.stdout.trim();
      return process.execPath; // fallback
    })();

    const initArgs = ["init", "--project", projectName, "--domain", domain, "--yes"];
    if (options.ingressProvider) initArgs.push("--ingress-provider", options.ingressProvider);
    const initResult = spawnSync(binaryPath, initArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    if (initResult.status !== 0) {
      const output = initResult.stdout ? String(initResult.stdout) : "";
      const stderr = initResult.stderr ? String(initResult.stderr) : "";
      if (!output.includes("already") && !output.includes("exist")) {
        console.error(`    Init failed: ${stderr || "unknown error"}`);
        console.error("    Run 'appbay init' separately to diagnose.");
        process.exit(1);
      }
    }
    console.log("    Scaffold ready.");

    const appbayHome = resolveAppbayHome();
    // Prerequisite checks resolve the runtime before init writes project.yaml, which caches
    // an empty instance config. Drop it so this same process sees the selected edge.
    clearContainerRuntimeCache(appbayHome);

    // ── Step 4: Initialize vault ──────────────────────────────────────────
    step(4, totalSteps, "Initializing secrets vault...");

    const vaultArgs = ["secrets", "init"];
    const vaultResult = spawnSync(binaryPath, vaultArgs, {
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
    const deployResult = spawnSync(binaryPath, ["up", ingressProvider], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      encoding: "utf-8",
    });
    if (deployResult.status !== 0 || String(deployResult.stdout).includes("No apps found to deploy")) {
      console.error(`\n  Setup failed during ${ingressProvider} deployment.`);
      console.error(String(deployResult.stderr || deployResult.stdout || "unknown deployment error").trim());
      process.exit(1);
    }
    process.stdout.write(String(deployResult.stdout));

    if (ingressProvider === "traefik") {
        console.log("    Waiting for Traefik health...");
        const healthy = waitForHealth("http://localhost:8080/api/overview", 30_000);
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
        const healthy = waitForContainerHealth("appbay.caddy.caddy", 60_000) || waitForContainerHealth("appbay.caddy", 1);
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
          const reset = spawnSync(binaryPath, ["edge", "users", "reset-password", "admin", "--generate", "--reveal"], {
            stdio: ["pipe", "pipe", "pipe"], env: process.env, encoding: "utf-8",
          });
          if (reset.status !== 0) {
            console.error(String(reset.stderr || "Unable to initialize the edge administrator password.").trim());
            process.exit(1);
          }
          process.stdout.write(String(reset.stdout));
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
