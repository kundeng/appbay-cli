/**
 * Secrets trait definition.
 *
 * URI-based secret references with provider selection and injection mode.
 * Secrets are resolved at DEPLOY time only, never at compile time.
 *
 * At compile time, the trait:
 *   1. Records which secrets need resolution in traitMetadata.secretRefs
 *   2. Does NOT inject URIs or values into the rendered compose
 *
 * At deploy time (CLI shepherd phase 2), the secretRefs metadata is used
 * to resolve URIs via SecretStore providers and inject the values as
 * process environment to `docker compose up`.
 *
 * Scope: service-level.
 */

import { SecretsTraitSchema } from "../../schemas/appbay-yaml.js";
import type { SecretsTrait } from "../../schemas/appbay-yaml.js";
import type {
  TraitDefinition,
  TraitTransformInput,
  TraitTransformOutput,
  ShepherdAction,
} from "../types.js";
import { containerBin } from "../../runtime/container-runtime.js";

// ---------------------------------------------------------------------------
// Trait Definition
// ---------------------------------------------------------------------------

export const secretsTraitDefinition: TraitDefinition<"secrets"> = {
  type: "secrets",
  category: "core",
  scope: "service",
  conflictsWith: [],
  description:
    "Secret provider selection + URI-based injection. Supports " +
    "runtime-env (default) and wrapper injection modes.",
  schema: SecretsTraitSchema,
  transform(input: TraitTransformInput): TraitTransformOutput {
    const props = input.properties as SecretsTrait;
    const compose = structuredClone(input.compose);
    const auxiliaryFiles: Array<{ path: string; content: string }> = [];

    // Replace env var values in the target service with ${KEY} references
    // so docker compose resolves them from the process environment at deploy
    // time. Without this, hardcoded values in the compose file would
    // override the secret values injected via process env.
    if (props.injection === "runtime-env") {
      const targetService = input.service;
      const services = compose.services as Record<string, Record<string, unknown>> | undefined;

      if (targetService && services?.[targetService]) {
        const svc = services[targetService];
        const env = svc.environment;
        const refKeys = new Set(Object.keys(props.refs));

        const handledKeys = new Set<string>();

        if (Array.isArray(env)) {
          // Array-style: ["KEY=value", "KEY2=value2"]
          //
          // Case 1: refs key matches env var key → rewrite value to ${REFS_KEY}
          //         (handles hardcoded literals AND mismatched ${OTHER} references)
          // Case 2: refs key appears as ${REFS_KEY} in some value → already wired,
          //         just inject process env at deploy time
          // Case 3: refs key not found → add KEY=${KEY} to environment
          svc.environment = env.map((entry: unknown) => {
            if (typeof entry !== "string") return entry;
            const eqIdx = (entry as string).indexOf("=");
            if (eqIdx < 0) return entry;
            const key = (entry as string).substring(0, eqIdx);
            const val = (entry as string).substring(eqIdx + 1);
            if (refKeys.has(key)) {
              handledKeys.add(key);
              // Case 1: refs key matches env var key — always rewrite
              return `${key}=\${${key}}`;
            }
            // Case 2: check if any refs key appears as ${REFS_KEY} in this value
            for (const rk of refKeys) {
              if (val.includes(`\${${rk}}`) || val.includes(`\${${rk}:-`)) {
                handledKeys.add(rk);
              }
            }
            return entry;
          });
          // Case 3: add missing refs keys not matched as env var key or ${REF} in values
          for (const key of refKeys) {
            if (!handledKeys.has(key)) {
              (svc.environment as string[]).push(`${key}=\${${key}}`);
            }
          }
        } else if (env && typeof env === "object") {
          // Object-style: { KEY: "value" }
          const envObj = env as Record<string, unknown>;
          for (const key of refKeys) {
            if (key in envObj) {
              // Case 1: refs key matches env var key — always rewrite
              envObj[key] = `\${${key}}`;
              handledKeys.add(key);
            } else {
              // Case 2: check if ${KEY} appears in any value
              for (const val of Object.values(envObj)) {
                const s = String(val ?? "");
                if (s.includes(`\${${key}}`) || s.includes(`\${${key}:-`)) {
                  handledKeys.add(key);
                  break;
                }
              }
            }
          }
          // Case 3: add missing refs keys
          for (const key of refKeys) {
            if (!handledKeys.has(key)) {
              envObj[key] = `\${${key}}`;
            }
          }
        } else if (!env) {
          // No environment block at all — create one with ${KEY} refs
          // so process env flows through to override env_file values.
          const envObj: Record<string, string> = {};
          for (const key of refKeys) {
            envObj[key] = `\${${key}}`;
          }
          svc.environment = envObj;
        }
      }
    }

    // wrapper-file: add a read-only volume mount for /run/secrets/<app>
    if (props.injection === "wrapper-file") {
      const services = compose.services as Record<string, Record<string, unknown>> | undefined;
      const volumeName = `appbay-secrets-${input.app}`;

      // 🚨 THE ENV-BASED GUESS IS SELF-DEFEATING FOR THIS MODE. It selects services whose
      // `environment` already mentions the secret keys — but `wrapper-file` exists so that
      // secrets NEVER appear in the environment. A correctly-written app therefore matched
      // nothing, no mount was added, and the deploy reported success while the container
      // could not read a single secret.
      //
      // ⚠️ Measured end-to-end before this fix: the shepherd wrote
      // /run/secrets/<app>/DB_PASSWORD into volume `appbay-secrets-<app>` (23 bytes,
      // correct value), the volume was declared `external: true` at the top level — and
      // `docker inspect <container> --format '{{json .Mounts}}'` returned `[]`. Everything
      // worked except the one step that delivers it.
      //
      // Falling back to EVERY service of the app is safe: the volume holds that app's own
      // secrets and is mounted read-only. Mounting where it is not read costs nothing;
      // mounting nowhere makes the whole mode a no-op.
      const guessed = Object.keys(services ?? {}).filter((svcName) => {
        const env = (services![svcName] as Record<string, unknown>).environment;
        if (!env) return false;
        const refKeys = new Set(Object.keys(props.refs));
        const envStr = JSON.stringify(env);
        return [...refKeys].some((k) => envStr.includes(k));
      });
      const targetNames = input.service && services?.[input.service]
        ? [input.service]
        : guessed.length > 0
          ? guessed
          : Object.keys(services ?? {});

      for (const svcName of targetNames) {
        const svc = services![svcName] as Record<string, unknown>;
        const volumes = (svc.volumes ?? []) as string[];
        volumes.push(`${volumeName}:/run/secrets/${input.app}:ro`);
        svc.volumes = volumes;
      }

      const topVolumes = (compose.volumes ?? {}) as Record<string, unknown>;
      topVolumes[volumeName] = { external: true };
      compose.volumes = topVolumes;
    }

    // entrypoint-wrapper: appbay-inject binary reads encrypted bundle from volume
    if (props.injection === "entrypoint-wrapper") {
      const services = compose.services as Record<string, Record<string, unknown>> | undefined;
      const volumeName = `appbay-secrets-${input.app}`;
      const secretsDir = `/run/secrets/${input.app}`;
      const refKeys = new Set(Object.keys(props.refs));

      // Find all services that reference any secret key
      const targetNames = input.service && services?.[input.service]
        ? [input.service]
        : Object.keys(services ?? {}).filter((svcName) => {
            const env = (services![svcName] as Record<string, unknown>).environment;
            if (!env) return false;
            const envStr = JSON.stringify(env);
            return [...refKeys].some((k) => envStr.includes(k));
          });

      // Build per-service env var mapping: { serviceName: { vaultKey: envVarName } }
      const mapping: Record<string, Record<string, string>> = {};

      for (const svcName of targetNames) {
        const svc = services![svcName] as Record<string, unknown>;
        const svcMapping: Record<string, string> = {};

        // Analyze environment block to find vault key → env var name mappings
        const env = svc.environment;
        if (Array.isArray(env)) {
          for (const entry of env) {
            if (typeof entry !== "string") continue;
            const eqIdx = entry.indexOf("=");
            if (eqIdx < 0) continue;
            const envVarName = entry.substring(0, eqIdx);
            const val = entry.substring(eqIdx + 1);
            // Check if value references a secret key via ${KEY} or ${KEY:-default}
            for (const rk of refKeys) {
              if (envVarName === rk || val.includes(`\${${rk}}`) || val.includes(`\${${rk}:-`)) {
                svcMapping[rk] = envVarName;
              }
            }
          }
        } else if (env && typeof env === "object") {
          for (const [envVarName, val] of Object.entries(env as Record<string, unknown>)) {
            const valStr = String(val ?? "");
            for (const rk of refKeys) {
              if (envVarName === rk || valStr.includes(`\${${rk}}`) || valStr.includes(`\${${rk}:-`)) {
                svcMapping[rk] = envVarName;
              }
            }
          }
        }

        mapping[svcName] = svcMapping;

        // Remove secret ${VAR} references from environment (appbay-inject handles them)
        if (Array.isArray(env)) {
          svc.environment = (env as string[]).filter((entry) => {
            if (typeof entry !== "string") return true;
            const eqIdx = entry.indexOf("=");
            if (eqIdx < 0) return true;
            const envVarName = entry.substring(0, eqIdx);
            return !Object.values(svcMapping).includes(envVarName);
          });
        } else if (env && typeof env === "object") {
          const envObj = env as Record<string, unknown>;
          for (const envVarName of Object.values(svcMapping)) {
            delete envObj[envVarName];
          }
        }

        // Mount secrets volume + appbay-inject binary
        const volumes = (svc.volumes ?? []) as string[];
        volumes.push(`${volumeName}:${secretsDir}:ro`);
        const injectBinPath = `${input.context.appsDir.replace("/etc/apps", "/bin/appbay-inject")}`;
        volumes.push(`${injectBinPath}:/appbay-inject:ro`);
        svc.volumes = volumes;

        // Rewrite entrypoint to appbay-inject
        const originalEntrypoint = svc.entrypoint;
        const originalCmd = svc.command;
        const injectArgs = ["/appbay-inject", "--app", input.app, "--service", svcName, "--"];

        if (originalEntrypoint) {
          const ep = Array.isArray(originalEntrypoint) ? originalEntrypoint : [String(originalEntrypoint)];
          const cmd = originalCmd ? (Array.isArray(originalCmd) ? originalCmd : [String(originalCmd)]) : [];
          svc.entrypoint = [...injectArgs, ...ep];
          svc.command = cmd;
        } else if (originalCmd) {
          const cmd = Array.isArray(originalCmd) ? originalCmd : [String(originalCmd)];
          svc.entrypoint = [...injectArgs, ...cmd];
          delete svc.command;
        } else {
          // No explicit entrypoint or command in compose. Docker Compose
          // zeros CMD when entrypoint is set, so we need to provide
          // the original image entrypoint explicitly. Look up the image
          // and run `docker image inspect` to find it.
          const image = svc.image as string | undefined;
          if (image) {
            const { spawnSync: ss } = require("node:child_process");
            const inspectResult = ss(containerBin(), [
              "image", "inspect", image,
              "--format", "{{json .Config.Entrypoint}}|||{{json .Config.Cmd}}",
            ], { stdio: "pipe", encoding: "utf-8", timeout: 10_000 });

            if (inspectResult.status === 0) {
              const [epJson, cmdJson] = String(inspectResult.stdout).trim().split("|||");
              const imgEp = JSON.parse(epJson || "null") as string[] | null;
              const imgCmd = JSON.parse(cmdJson || "null") as string[] | null;
              const fullCmd = [...(imgEp ?? []), ...(imgCmd ?? [])];
              if (fullCmd.length > 0) {
                svc.entrypoint = [...injectArgs, ...fullCmd];
              } else {
                svc.entrypoint = injectArgs;
              }
            } else {
              svc.entrypoint = injectArgs;
            }
          } else {
            svc.entrypoint = injectArgs;
          }
        }
      }

      // Write mapping as auxiliary file
      auxiliaryFiles.push({
        path: `etc/apps/${input.app}/secrets-mapping.json`,
        content: JSON.stringify(mapping, null, 2) + "\n",
      });

      const topVolumes = (compose.volumes ?? {}) as Record<string, unknown>;
      topVolumes[volumeName] = { external: true };
      compose.volumes = topVolumes;
    }

    const shepherd: ShepherdAction[] = [];

    if (props.injection === "wrapper-file") {
      shepherd.push({
        phase: "pre-deploy",
        label: `secrets:materialize ${input.app} (wrapper-file)`,
        run: async (ctx) => {
          const { resolveWrapperFileSecrets } = await import("../../secrets/resolve-for-deploy.js");
          const refs = Object.entries(props.refs).map(([key, uri]) => ({
            key, uri, provider: props.provider, injection: "wrapper-file" as const,
            app: input.app, service: input.service,
          }));
          const result = await resolveWrapperFileSecrets(refs, ctx.appName);
          if (result.errors.length > 0) {
            throw new Error(result.errors.map((e) => `${e.ref.key}: ${e.error}`).join("; "));
          }
        },
      });
    }

    if (props.injection === "entrypoint-wrapper") {
      const mappingForShepherd = auxiliaryFiles.find((f) => f.path.endsWith("secrets-mapping.json"));
      shepherd.push({
        phase: "pre-deploy",
        label: `secrets:encrypt-bundle ${input.app}`,
        run: async (ctx) => {
          const { writeEncryptedBundle } = await import("../../secrets/resolve-for-deploy.js");
          const refs = Object.entries(props.refs).map(([key, uri]) => ({
            key, uri, provider: props.provider, injection: "entrypoint-wrapper" as const,
            app: input.app, service: input.service,
          }));
          const mapping = mappingForShepherd
            ? JSON.parse(mappingForShepherd.content)
            : {};
          const result = await writeEncryptedBundle(refs, ctx.appName, mapping);
          if (result.errors.length > 0) {
            throw new Error(result.errors.map((e) => `${e.ref.key}: ${e.error}`).join("; "));
          }
        },
      });
    }

    return {
      compose,
      auxiliaryFiles: auxiliaryFiles.length > 0 ? auxiliaryFiles : undefined,
      metadata: {
        secretRefs: Object.entries(props.refs).map(([key, uri]) => ({
          key,
          uri,
          provider: props.provider,
          injection: props.injection,
          optional: (props.optional ?? []).includes(key),
          app: input.app,
          service: input.service,
        })),
      },
      shepherd: shepherd.length > 0 ? shepherd : undefined,
    };
  },
};
