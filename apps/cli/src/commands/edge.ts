/** Caddy Security local edge-identity administration. */
import { Command } from "commander";
import { randomBytes } from "node:crypto";
import { EdgeIdentityStore, restartEdgeForIdentityChange } from "@appbay/core";
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
    console.log(restartEdgeForIdentityChange() ? "  Caddy restarted to load the identity store." : "  Caddy is not running; the identity will load on next start.");
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
    console.log(restartEdgeForIdentityChange() ? "  Caddy restarted to load the identity store." : "  Caddy is not running; the identity will load on next start.");
  });

const users = new Command("users").description("Manage users who sign in to your DEPLOYED APPS (not to AppBay itself)")
  .addCommand(listUsers).addCommand(createUser).addCommand(resetPassword);

export const edgeCommand = new Command("edge")
  .description("Manage the edge: the proxy, and the users who sign in to your DEPLOYED APPS")
  .addCommand(users);
