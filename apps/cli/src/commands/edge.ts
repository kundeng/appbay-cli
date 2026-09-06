/** Caddy Security local edge-identity administration. */
import { Command } from "commander";
import { randomBytes } from "node:crypto";
import { EdgeIdentityStore, restartEdgeForIdentityChange, migrateEdge, deploy, writeRenderedOutput, resolveDeployEnv, containerCompose, findContainerByLabel, APP_LABEL, IngressProviderSchema, type IngressProvider, compileInstall } from "@appbay/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dockerCompose } from "../utils/docker.js";
import { upsertIngressProvider } from "./init.js";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { askSecret } from "../utils/prompt.js";

async function readPasswordFromStdin(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  const password = value.replace(/[\r\n]+$/, "");
  if (!password) throw new Error("No password received on standard input.");
  return password;
}

async function passwordFor(options: { generate?: boolean; passwordStdin?: boolean }): Promise<{ password: string; generated: boolean }> {
  if (options.generate && options.passwordStdin) throw new Error("Choose only one of --generate or --password-stdin.");
  if (options.generate) return { password: randomBytes(24).toString("base64url"), generated: true };
  if (options.passwordStdin) return { password: await readPasswordFromStdin(), generated: false };
  if (!process.stdin.isTTY) throw new Error("Use --password-stdin or --generate when standard input is not a terminal.");
  const password = await askSecret("Edge user password");
  if (!password) throw new Error("Password cannot be empty.");
  return { password, generated: false };
}

const listUsers = new Command("list")
  .description("List Caddy Security local users")
  .action(async () => {
    const document = await new EdgeIdentityStore(resolveAppbayHome()).read();

    // An empty store is a normal state (fresh install, or the edge has never provisioned),
    // and silence is indistinguishable from a command that did nothing. Say which it is,
    // and name the next step — this is usually the first edge command anyone runs.
    if (document.users.length === 0) {
      console.log("No edge users yet.");
      console.log("  Create one:  appbay edge users create <username> --email <email> --generate --reveal");
      console.log("  ⚠️ Edge users sign in to your DEPLOYED APPS. They are not AppBay");
      console.log("     control-plane accounts — see `appbay admin` for those.");
      return;
    }

    for (const user of document.users) {
      const roles = user.roles.map((role) => `${role.organization}/${role.name}`).join(",");
      console.log(`${user.username}\t${user.email_address.address}\t${roles}`);
    }
  });

const createUser = new Command("create")
  .description("Create a Caddy Security local edge user")
  .argument("<username>")
  .requiredOption("--email <email>")
  .option("--roles <roles>", "comma-separated roles", "user")
  .option("--generate", "generate a password")
  .option("--password-stdin", "read password from standard input")
  .option("--reveal", "print a generated password once")
  .action(async (username: string, options: { email: string; roles: string; generate?: boolean; passwordStdin?: boolean; reveal?: boolean }) => {
    if (options.reveal && !options.generate) throw new Error("--reveal is valid only with --generate.");
    const { password, generated } = await passwordFor(options);
    const user = await new EdgeIdentityStore(resolveAppbayHome()).create({
      username, email: options.email,
      password, roles: options.roles.split(",").map((role) => role.trim()).filter(Boolean),
    });
    console.log(`Created edge user: ${user.username}`);
    if (generated && options.reveal) console.log(`  Password: ${password}`);
    await reportEdgeRestart();
  });

const resetPassword = new Command("reset-password")
  .description("Reset the password for an EDGE USER — someone signing in to your deployed apps. Not the AppBay account — see `appbay admin`.")
  .argument("<username>")
  .option("--generate", "generate a password")
  .option("--password-stdin", "read password from standard input")
  .option("--reveal", "print a generated password once")
  .action(async (username: string, options: { generate?: boolean; passwordStdin?: boolean; reveal?: boolean }) => {
    if (options.reveal && !options.generate) throw new Error("--reveal is valid only with --generate.");
    const { password, generated } = await passwordFor(options);
    await new EdgeIdentityStore(resolveAppbayHome()).resetPassword(username, password);
    console.log(`Reset edge-user password: ${username}`);
    if (generated && options.reveal) console.log(`  Password: ${password}`);
    await reportEdgeRestart();
  });

/** Restart the edge so the identity change takes effect, and say what happened; a failed restart exits 1. */
async function reportEdgeRestart(): Promise<void> {
  const restart = await restartEdgeForIdentityChange(resolveAppbayHome());
  if (restart === "restarted") { console.log("  Caddy restarted to load the identity store."); return; }
  if (restart === "not-running") { console.log("  Caddy is not running; the identity will load on next start."); return; }
  console.error(`  Caddy did NOT restart (${restart.failed}); the identity is on disk but Caddy will not authenticate it until it restarts. Run: appbay restart caddy`);
  process.exit(1);
}

const users = new Command("users").description("Manage users who sign in to your DEPLOYED APPS (not to AppBay itself)")
  .addCommand(listUsers).addCommand(createUser).addCommand(resetPassword);

/**
 * `appbay edge migrate --to <provider>` — change the ingress provider without a window in
 * which the host has no edge. Calls core's `migrateEdge()`, which had no caller (issue #7)
 * while `init` advised the unsafe stop-then-hope sequence it was written to replace.
 *
 * The four operations it needs, in this install's terms:
 *   validate  compile the target edge and, for caddy, run `caddy validate` in the edge image
 *             with the candidate tree mounted — while the current edge still serves
 *   stop      `compose down` on the outgoing render
 *   start     `deploy()` for the target edge
 *   health    the target edge, found by label, is running within 60 s
 */
const migrate = new Command("migrate")
  .description("Switch the ingress provider, validating first and restoring the old edge on any failure")
  .requiredOption("--to <provider>", "target provider: traefik or caddy")
  .action(async (options: { to: string }) => {
    const parsed = IngressProviderSchema.safeParse(options.to);
    if (!parsed.success) throw new Error(`--to must be "traefik" or "caddy", got "${options.to}"`);
    const to = parsed.data;
    const appbayHome = resolveAppbayHome();
    // The outgoing edge is the one observed running, not "the other one" and not the config:
    // after `init --ingress-provider` the config names an edge that is not serving yet, and
    // the old derivation reported "<other> is still serving" for whichever was asked.
    const serving: IngressProvider[] = [];
    for (const p of ["traefik", "caddy"] as const) {
      const c = await findContainerByLabel(APP_LABEL, p, { appbayHome });
      if (c.kind === "unknown") { console.error(`Could not ask the runtime which edge is serving: ${c.reason}`); process.exit(1); }
      if (c.value?.running) serving.push(p);
    }
    if (serving.includes(to)) {
      console.error(`${to} is already serving; nothing to migrate.`);
      process.exit(1);
    }
    const from: IngressProvider = serving[0] ?? (to === "caddy" ? "traefik" : "caddy");
    const appsDir = join(appbayHome, "etc", "apps");
    const rendersDir = join(appbayHome, "var", "lib", "renders");

    if (!existsSync(join(appsDir, to, "docker-compose.yml"))) {
      console.error(`The ${to} edge is not installed here. Seed it first: appbay init --ingress-provider ${to}`);
      process.exit(1);
    }

    const renderFor = (p: IngressProvider) => join(rendersDir, p, "docker-compose.rendered.yml");

    const result = await migrateEdge({
      appbayHome, from, to,
      validateCandidate: async () => {
        const compiled = await compileInstall(appbayHome, { apps: [to] });
        if (compiled.errors.length > 0) return compiled.errors.map((e) => `${e.stage}: ${e.message}`).join("; ");
        const app = compiled.apps[0];
        if (!app) return `${to} did not compile to an app`;
        const render = await writeRenderedOutput(app, rendersDir, appbayHome);
        if (to !== "caddy") return null; // ponytail: traefik has no offline validator; the health step is its check
        // The same env the deploy will pass: secrets and .env.local. Without it the
        // Caddyfile's secret-bearing directives validate against empty strings and fail.
        const resolved = await resolveDeployEnv(app, appsDir);
        if (resolved.error) return resolved.error;
        // The render carries no `build:` (the compiler strips it and pins the tag), so the
        // image is built the way the deploy builds it: the manifest's build actions.
        for (const action of app.shepherdActions.filter((a) => a.kind === "build")) {
          try {
            await action.run?.({ appName: app.appName, appbayHome, secretEnv: resolved.env });
          } catch (err) {
            return `could not build the ${to} image (${action.label}): ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        const check = containerCompose(
          ["run", "--rm", "--no-deps", "--entrypoint", "caddy", to, "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
          render, resolved.env, appbayHome,
        );
        if (check.exitCode === 0) return null;
        return check.output.trim().split("\n").filter((l) => !l.startsWith("time=") && !l.startsWith(" ")).slice(-3).join("\n");
      },
      stopStack: async (p) => {
        const render = renderFor(p);
        if (!existsSync(render)) return;
        const down = containerCompose(["down"], render, undefined, appbayHome);
        if (down.exitCode !== 0) throw new Error(`compose down ${p}: ${down.output.trim()}`);
      },
      startStack: async (p) => {
        const r = await deploy({ appbayHome, targetApps: [p], dockerCompose: (a, c, e) => dockerCompose(a, c, e) });
        if (r.compileErrors.length > 0) throw new Error(`${p} could not be deployed: ${r.compileErrors.map((e) => `${e.stage}: ${e.message}`).join("; ")}`);
        const failed = r.apps.find((a) => a.status === "failed");
        if (failed) throw new Error(failed.error ?? `${p} failed to deploy`);
        if (r.apps.some((a) => a.convergeAction === "unknown")) throw new Error(`${p}: the runtime could not be read after start`);
      },
      checkHealth: async (p) => {
        const deadline = Date.now() + 60_000;
        let last = "not found";
        while (Date.now() < deadline) {
          const edge = await findContainerByLabel(APP_LABEL, p, { appbayHome });
          if (edge.kind === "unknown") return `could not ask the runtime: ${edge.reason}`;
          if (edge.value?.running) return null;
          last = edge.value ? `${edge.value.name} is ${edge.value.state}` : "no container carries the label";
          await new Promise((r) => setTimeout(r, 2000));
        }
        return `${p} did not come up within 60 s (${last})`;
      },
    });

    for (const step of result.steps) {
      console.log(`  ${step.ok ? "✓" : "✗"} ${step.label}${step.detail ? ` — ${step.detail}` : ""}`);
    }
    if (result.migrated) {
      await upsertIngressProvider(appbayHome, to);
      console.log(`\nEdge is now ${to}. Re-run \`appbay up\` for apps with routes so their fragments target it.`);
      process.exit(0);
    }
    console.error(result.restored === false ? "\n🚨 The host may have no edge. Check the steps above." : `\nNot migrated; ${from} is still serving.`);
    process.exit(1);
  });

export const edgeCommand = new Command("edge")
  .description("Manage the edge: the proxy, and the users who sign in to your DEPLOYED APPS")
  .addCommand(users)
  .addCommand(migrate);
