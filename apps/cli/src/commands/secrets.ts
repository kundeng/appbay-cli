/**
 * `appbay secrets` command group.
 *
 * Thin CLI wrapper over @appbay/core vault-service and secret checking.
 * Contains only argument parsing and console output formatting.
 *
 * Subcommands:
 *   init         -- initialize the local secrets vault
 *   set KEY VAL  -- store a secret in the vault
 *   get KEY      -- retrieve a secret from the vault
 *   delete KEY   -- delete a secret from the vault
 *   vault        -- list all vault secrets
 *   scan APP     -- discover secret-like env vars
 *   check        -- verify all secret URIs resolve
 *   list [app]   -- list secret references per app
 *
 * Exit codes:
 *   0 -- success
 *   1 -- failure (missing secret, resolution error, etc.)
 */

import { Command } from "commander";
import { join } from "node:path";
import {
  discoverApps,
  SecretStore,
  EnvSecretProvider,
  FileSecretProvider,
  SopsSecretProvider,
  VaultSecretProvider,
  KeePassSecretProvider,
  initVault,
  rotateVaultPassword,
  repairVaultPasswordFile,
  setSecret,
  getSecret,
  deleteSecret,
  listVaultSecrets,
  scanAppSecrets,
  initKdbx,
  setKdbxSecret,
  getKdbxSecret,
  deleteKdbxSecret,
  listKdbxSecrets,
  type DiscoveredApp,
} from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { pad } from "../utils/formatting.js";
import { splitScopedKey } from "@appbay/core";

/** A secret reference found in an app's compose environment variables. */
interface SecretRef {
  app: string;
  service: string;
  envVar: string;
  uri: string;
}

const SECRET_URI_PATTERN = /^(vault|keepass|file|env|sops):\/\/.+$/;

function extractSecretRefs(app: DiscoveredApp): SecretRef[] {
  const refs: SecretRef[] = [];
  const services = app.composeContent?.services;

  if (!services || typeof services !== "object") return refs;

  for (const [serviceName, serviceDef] of Object.entries(services as Record<string, unknown>)) {
    if (!serviceDef || typeof serviceDef !== "object") continue;
    const env = (serviceDef as Record<string, unknown>).environment;
    if (!env || typeof env !== "object") continue;

    if (Array.isArray(env)) {
      for (const entry of env) {
        if (typeof entry !== "string") continue;
        const eqIdx = entry.indexOf("=");
        if (eqIdx < 0) continue;
        const key = entry.substring(0, eqIdx);
        const value = entry.substring(eqIdx + 1);
        if (SECRET_URI_PATTERN.test(value)) {
          refs.push({ app: app.name, service: serviceName, envVar: key, uri: value });
        }
      }
    } else {
      for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
        if (typeof value === "string" && SECRET_URI_PATTERN.test(value)) {
          refs.push({ app: app.name, service: serviceName, envVar: key, uri: value });
        }
      }
    }
  }

  return refs;
}

function createSecretStore(): SecretStore {
  const store = new SecretStore();
  store.registerProvider(new EnvSecretProvider());
  store.registerProvider(new FileSecretProvider());
  store.registerProvider(new SopsSecretProvider());
  store.registerProvider(new VaultSecretProvider());
  store.registerProvider(new KeePassSecretProvider());
  return store;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const checkCommand = new Command("check")
  .description("Check that all secret URI references resolve")
  .action(async () => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");
    const discovered = await discoverApps({ appsDir });

    if (discovered.length === 0) {
      console.log("No apps found.");
      process.exit(0);
    }

    const allRefs: SecretRef[] = [];
    for (const app of discovered) {
      allRefs.push(...extractSecretRefs(app));
    }

    if (allRefs.length === 0) {
      console.log("No secret URI references found in any app.");
      process.exit(0);
    }

    console.log(`Checking ${allRefs.length} secret reference(s)...\n`);

    const store = createSecretStore();
    const uris = allRefs.map((r) => r.uri);
    const results = await store.checkAll(uris);

    let resolved = 0;
    let missing = 0;
    let errored = 0;

    for (let i = 0; i < allRefs.length; i++) {
      const ref = allRefs[i];
      const result = results[i];
      const statusIcon = result.ok ? "\u2713" : "\u2717";
      const statusLabel = result.ok ? "resolved" : result.error ?? "missing";
      const prefix = `[${ref.app}/${ref.service}]`;

      console.log(`  ${statusIcon} ${pad(prefix, 30)} ${ref.envVar} = ${ref.uri}`);
      if (!result.ok) {
        console.log(`${" ".repeat(34)}${statusLabel}`);
        if (result.error) errored++;
        else missing++;
      } else {
        resolved++;
      }
    }

    console.log(`\n${resolved} resolved, ${missing} missing, ${errored} error(s)`);
    process.exit(missing + errored > 0 ? 1 : 0);
  });

const listSubcommand = new Command("list")
  .description("List secret references for an app (or all apps)")
  .argument("[app]", "specific app to list secrets for")
  .action(async (app: string | undefined) => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");
    const discovered = await discoverApps({ appsDir });

    if (discovered.length === 0) {
      console.log("No apps found.");
      process.exit(0);
    }

    let targets = discovered;
    if (app) {
      targets = discovered.filter((a) => a.name === app);
      if (targets.length === 0) {
        console.error(`App "${app}" not found in ${appsDir}`);
        process.exit(1);
      }
    }

    const allRefs: SecretRef[] = [];
    for (const target of targets) {
      allRefs.push(...extractSecretRefs(target));
    }

    if (allRefs.length === 0) {
      console.log(app ? `No secret references found in "${app}".` : "No secret references found.");
      process.exit(0);
    }

    const byApp = new Map<string, SecretRef[]>();
    for (const ref of allRefs) {
      const list = byApp.get(ref.app) ?? [];
      list.push(ref);
      byApp.set(ref.app, list);
    }

    for (const [appName, refs] of byApp) {
      console.log(`${appName}:`);
      for (const ref of refs) {
        console.log(`  ${ref.service}.${ref.envVar} = ${ref.uri}`);
      }
      console.log("");
    }

    console.log(`${allRefs.length} secret reference(s) total`);
  });

// ---------------------------------------------------------------------------
// Vault subcommands — delegate to @appbay/core vault-service
// ---------------------------------------------------------------------------

const vaultSubcommand = new Command("vault")
  .description("List all secrets stored in the vault")
  .option("--scope <scope>", "filter by scope (e.g., kestra, homelab/production)")
  .action(async (options: { scope?: string }) => {
    const appbayHome = resolveAppbayHome();

    try {
      const result = listVaultSecrets(appbayHome, options.scope);

      if (result.total === 0) {
        console.log(options.scope
          ? `No secrets in scope "${options.scope}".`
          : "Vault is empty.");
        process.exit(0);
      }

      for (const [scope, keys] of Object.entries(result.byScope)) {
        console.log(`${scope}/`);
        for (const key of keys) {
          console.log(`  ${key}`);
        }
      }

      console.log(`\n${result.total} secret(s)`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const vaultRotatePasswordCommand = new Command("rotate-password")
  .description("Re-encrypt the local vault with a new master password")
  .option("--password-stdin", "read the new password from standard input instead of generating one")
  .option("--json", "emit machine-readable status")
  .action(async (options: { passwordStdin?: boolean; json?: boolean }) => {
    try {
      const password = options.passwordStdin
        ? await readSecretFromStdin()
        : undefined;
      if (options.passwordStdin && !password) throw new Error("No new password received on standard input.");
      const result = rotateVaultPassword(resolveAppbayHome(), password);
      const status = { changed: true, entries: result.entries, generated: result.generated };
      if (options.json) console.log(JSON.stringify(status));
      else console.log(`Vault password rotated; re-encrypted ${result.entries} secret(s).`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const vaultRepairPasswordFileCommand = new Command("repair-password-file")
  .description("Rewrite the local vault password file after verifying the configured password")
  .action(() => {
    try {
      const result = repairVaultPasswordFile(resolveAppbayHome());
      console.log(`Vault password file repaired: ${result.passwordPath}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

vaultSubcommand.addCommand(vaultRotatePasswordCommand);
vaultSubcommand.addCommand(vaultRepairPasswordFileCommand);

const scanSubcommand = new Command("scan")
  .description("Discover secret-like env vars in an app's compose and .env files")
  .argument("<app>", "app name to scan")
  .action(async (appName: string) => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");
    const discovered = await discoverApps({ appsDir });
    const app = discovered.find((a) => a.name === appName);

    if (!app) {
      console.error(`App "${appName}" not found in ${appsDir}`);
      process.exit(1);
    }

    const result = scanAppSecrets(app, appbayHome);

    if (result.vars.length === 0) {
      console.log(`No environment variables found in "${appName}".`);
      process.exit(0);
    }

    if (result.secrets.length > 0) {
      console.log(`Detected secrets (${result.secrets.length}):\n`);
      for (const v of result.secrets) {
        const status = v.hasVaultRef ? "vault-ref" : v.isPlaceholder ? "PLACEHOLDER" : "has-value";
        const svc = v.service ? `${v.service}.` : "";
        const src = v.source === "compose" ? "" : ` (${v.source})`;
        console.log(`  ${svc}${v.key} = ${v.value || "(empty)"}  [${status}]${src}`);
      }

      if (result.unmanaged.length > 0) {
        console.log(`\nSuggested vault refs for ${appName}:\n`);
        console.log("  traits:");
        console.log("    - type: secrets");
        console.log("      refs:");
        for (const v of result.unmanaged) {
          console.log(`        ${v.key}: "vault://${appName}/${v.key}"`);
        }
      }
    }

    const others = result.vars.filter((v) => !v.looksSecret);
    if (others.length > 0) {
      console.log(`\nOther env vars (${others.length}):\n`);
      for (const v of others) {
        const svc = v.service ? `${v.service}.` : "";
        const src = v.source === "compose" ? "" : ` (${v.source})`;
        console.log(`  ${svc}${v.key} = ${v.value || "(empty)"}${src}`);
      }
    }

    console.log(`\n${result.vars.length} total, ${result.secrets.length} look like secrets`);
  });

const initSubcommand = new Command("init")
  .description("Initialize the local secrets vault")
  .option("--password <password>", "vault master password (or set APPBAY_VAULT_PASSWORD)")
  .action(async (options: { password?: string }) => {
    const appbayHome = resolveAppbayHome();

    const result = initVault(appbayHome, options.password);

    if (!result.generated && result.vaultPath) {
      console.log(`Vault already exists at ${result.vaultPath}`);
      process.exit(0);
    }

    if (result.generated) {
      console.log("  Generated vault password (stored automatically)");
    }

    console.log(`Vault initialized at ${result.vaultPath}`);
    console.log(`Password stored at ${result.passwordPath}`);
    console.log("\nUse 'appbay secrets set KEY VALUE' to add secrets.");
  });

/**
 * Read a secret value from stdin.
 *
 * 🚨 THIS EXISTS BECAUSE ARGV IS WORLD-READABLE. A value passed as
 * `appbay secrets set KEY <value>` appears in /proc/<pid>/cmdline, which on a default
 * Linux system any local user can read for the lifetime of the process. That is fine
 * for a human typing a throwaway value into their own shell; it is NOT fine for a
 * configuration-management run seeding real credentials onto a shared host, which is
 * exactly what this command is for.
 *
 * ⇒ `<value>` is now OPTIONAL. Omit it and the value is read from stdin:
 *
 *     printf %s "$SECRET" | appbay secrets set DB_PASSWORD
 *
 * Backwards compatible — passing the value as an argument still works, and still has
 * the exposure above.
 *
 * ⚠️ Trailing newline is stripped, because `echo` adds one and a secret with a
 * trailing \n fails authentication somewhere far away from here. Use `printf %s` to
 * be explicit; this strips one trailing newline for the people who forget.
 */
async function readSecretFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      "No value given and stdin is a TTY. Either pass the value as an argument, or " +
        'pipe it: printf %s "$SECRET" | appbay secrets set KEY',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8").replace(/\r?\n$/, "");
}

const setSubcommand = new Command("set")
  .description(
    "Store a secret in the local vault (supports app/key scoping). " +
      "Omit VALUE to read it from stdin, which keeps it out of /proc/<pid>/cmdline.",
  )
  .argument("<key>", "secret key — plain KEY or scoped APP/KEY")
  .argument("[value]", "secret value — omit to read from stdin (preferred for automation)")
  .action(async (keyArg: string, valueArg: string | undefined) => {
    const appbayHome = resolveAppbayHome();

    let value: string;
    try {
      value = valueArg !== undefined ? valueArg : await readSecretFromStdin();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
      return;
    }

    if (value === "") {
      console.error(
        `Refusing to store an empty value for "${keyArg}". An empty secret fails later, ` +
          "somewhere unrelated, and looks like a different bug.",
      );
      process.exit(1);
      return;
    }

    try {
      const existing = getSecret(appbayHome, keyArg);
      const result = setSecret(appbayHome, keyArg, value);
      console.log(`Secret "${result.key}" stored (scope: ${result.scope})`);
      console.log(`  URI: ${result.uri}`);

      if (existing !== null) {
        console.log(`\n  Note: this secret already existed and was overwritten.`);
        const isDbKey = /passw|db_|postgres|mysql|mongo|redis/i.test(result.key);
        if (isDbKey) {
          console.log(`  If this is a database password, the running database won't`);
          console.log(`  pick up the change. Use ALTER USER inside the DB container.`);
        }
        console.log(`  Run 'appbay up ${result.scope === "default" ? "" : result.scope}' to apply.`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const getSubcommand = new Command("get")
  .description("Retrieve a secret from the local vault")
  .argument("<key>", "secret key — plain KEY or scoped APP/KEY")
  .action(async (keyArg: string) => {
    const appbayHome = resolveAppbayHome();

    try {
      const value = getSecret(appbayHome, keyArg);
      if (value === null) {
        const { scope, key } = splitScopedKey(keyArg);
        console.error(`Secret "${key}" not found (scope: ${scope})`);
        process.exit(1);
      }
      console.log(value);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const deleteSubcommand = new Command("delete")
  .description("Delete a secret from the local vault")
  .argument("<key>", "secret key — plain KEY or scoped APP/KEY")
  .action(async (keyArg: string) => {
    const appbayHome = resolveAppbayHome();

    try {
      const result = deleteSecret(appbayHome, keyArg);
      if (result.deleted) {
        console.log(`Secret "${result.key}" deleted (scope: ${result.scope})`);
      } else {
        console.error(`Secret "${result.key}" not found (scope: ${result.scope})`);
        process.exit(1);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const importSubcommand = new Command("import")
  .description("Scan app and auto-create vault entries for unmanaged secrets")
  .argument("<app>", "app name to import secrets for")
  .option("--dry-run", "show what would be imported without storing")
  .action(async (appName: string, options: { dryRun?: boolean }) => {
    const appbayHome = resolveAppbayHome();
    const appsDir = join(appbayHome, "etc", "apps");
    const discovered = await discoverApps({ appsDir });
    const app = discovered.find((a) => a.name === appName);

    if (!app) {
      console.error(`App "${appName}" not found in ${appsDir}`);
      process.exit(1);
    }

    const result = scanAppSecrets(app, appbayHome);

    const toImport = result.secrets.filter(
      (v) => !v.hasVaultRef && v.value && !v.isPlaceholder,
    );
    const toGenerate = result.secrets.filter(
      (v) => !v.hasVaultRef && (!v.value || v.isPlaceholder),
    );

    if (toImport.length === 0 && toGenerate.length === 0) {
      console.log(`No unmanaged secrets found in "${appName}".`);
      process.exit(0);
    }

    try {
      initVault(appbayHome);
    } catch { /* vault may already exist */ }

    let imported = 0;
    let generated = 0;

    for (const v of toImport) {
      const key = `${appName}/${v.key}`;
      if (options.dryRun) {
        console.log(`  [import] ${key} = ${v.value.substring(0, 4)}${"*".repeat(Math.max(0, v.value.length - 4))}`);
      } else {
        setSecret(appbayHome, key, v.value);
        console.log(`  Imported ${v.key} → vault://${appName}/${v.key}`);
      }
      imported++;
    }

    for (const v of toGenerate) {
      const key = `${appName}/${v.key}`;
      if (options.dryRun) {
        console.log(`  [generate] ${key} (placeholder or empty — will auto-generate)`);
      } else {
        const { randomBytes } = await import("node:crypto");
        const value = randomBytes(24).toString("base64url");
        setSecret(appbayHome, key, value);
        console.log(`  Generated ${v.key} → vault://${appName}/${v.key}`);
      }
      generated++;
    }

    const action = options.dryRun ? "Would import" : "Imported";
    console.log(`\n${action} ${imported} existing + ${generated} generated = ${imported + generated} secrets`);

    if (!options.dryRun && (imported > 0 || generated > 0)) {
      console.log(`\nAdd to ${appName}/appbay.yaml:`);
      console.log("  traits:");
      console.log("    - type: secrets");
      console.log("      refs:");
      for (const v of [...toImport, ...toGenerate]) {
        console.log(`        ${v.key}: "vault://${appName}/${v.key}"`);
      }
    }
  });

// ---------------------------------------------------------------------------
// KeePass (.kdbx) subcommands
// ---------------------------------------------------------------------------

const initKdbxSubcommand = new Command("init-kdbx")
  .description("Initialize a KeePass .kdbx database for keepass:// secrets")
  .option("--password <password>", "database master password (or set APPBAY_KEEPASS_PASSWORD)")
  .action(async (options: { password?: string }) => {
    const appbayHome = resolveAppbayHome();

    try {
      const result = await initKdbx(appbayHome, options.password);

      if (!result.generated && result.dbPath) {
        console.log(`KeePass database already exists at ${result.dbPath}`);
        process.exit(0);
      }

      if (result.generated) {
        console.log("  Generated database password (stored automatically)");
      }

      console.log(`KeePass database initialized at ${result.dbPath}`);
      console.log(`Password stored at ${result.passwordPath}`);
      console.log("\nUse 'appbay secrets set-kdbx KEY VALUE' to add secrets.");
      console.log("Reference secrets with keepass:// URIs in appbay.yaml.");
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const setKdbxSubcommand = new Command("set-kdbx")
  .description("Store a secret in the KeePass database (supports app/key scoping)")
  .argument("<key>", "secret key — plain KEY or scoped APP/KEY")
  .argument("<value>", "secret value")
  .action(async (keyArg: string, value: string) => {
    const appbayHome = resolveAppbayHome();

    try {
      const existing = await getKdbxSecret(appbayHome, keyArg);
      const result = await setKdbxSecret(appbayHome, keyArg, value);
      console.log(`Secret "${result.key}" stored in KeePass (scope: ${result.scope})`);
      console.log(`  URI: ${result.uri}`);

      if (existing !== null) {
        console.log(`\n  Note: this secret already existed and was overwritten.`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const getKdbxSubcommand = new Command("get-kdbx")
  .description("Retrieve a secret from the KeePass database")
  .argument("<key>", "secret key — plain KEY or scoped APP/KEY")
  .action(async (keyArg: string) => {
    const appbayHome = resolveAppbayHome();

    try {
      const value = await getKdbxSecret(appbayHome, keyArg);
      if (value === null) {
        const { scope, key } = splitScopedKey(keyArg);
        console.error(`Secret "${key}" not found in KeePass (scope: ${scope})`);
        process.exit(1);
      }
      console.log(value);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const deleteKdbxSubcommand = new Command("delete-kdbx")
  .description("Delete a secret from the KeePass database")
  .argument("<key>", "secret key — plain KEY or scoped APP/KEY")
  .action(async (keyArg: string) => {
    const appbayHome = resolveAppbayHome();

    try {
      const result = await deleteKdbxSecret(appbayHome, keyArg);
      if (result.deleted) {
        console.log(`Secret "${result.key}" deleted from KeePass (scope: ${result.scope})`);
      } else {
        console.error(`Secret "${result.key}" not found in KeePass (scope: ${result.scope})`);
        process.exit(1);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const kdbxSubcommand = new Command("kdbx")
  .description("List all secrets stored in the KeePass database")
  .option("--scope <scope>", "filter by scope/group (e.g., kestra, homelab)")
  .action(async (options: { scope?: string }) => {
    const appbayHome = resolveAppbayHome();

    try {
      const result = await listKdbxSecrets(appbayHome, options.scope);

      if (result.total === 0) {
        console.log(options.scope
          ? `No secrets in scope "${options.scope}" (KeePass).`
          : "KeePass database is empty.");
        process.exit(0);
      }

      for (const [scope, keys] of Object.entries(result.byScope)) {
        console.log(`${scope}/`);
        for (const key of keys) {
          console.log(`  ${key}`);
        }
      }

      console.log(`\n${result.total} secret(s) in KeePass`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Parent command
// ---------------------------------------------------------------------------

export const secretsCommand = new Command("secrets")
  .description("Manage secrets — vault CRUD, KeePass CRUD, scanning, and checking")
  .addCommand(initSubcommand)
  .addCommand(setSubcommand)
  .addCommand(getSubcommand)
  .addCommand(deleteSubcommand)
  .addCommand(vaultSubcommand)
  .addCommand(initKdbxSubcommand)
  .addCommand(setKdbxSubcommand)
  .addCommand(getKdbxSubcommand)
  .addCommand(deleteKdbxSubcommand)
  .addCommand(kdbxSubcommand)
  .addCommand(scanSubcommand)
  .addCommand(importSubcommand)
  .addCommand(checkCommand)
  .addCommand(listSubcommand);
