/**
 * Build resolution — Stage 2d4 of the compiler pipeline.
 *
 * Compose conflates two lifecycles in one file: `build:` describes how to PRODUCE an image,
 * `image:`/`ports:`/`environment:` describe how to RUN one. appbay separates them, the same
 * way it already separates other concerns from the render:
 *
 *   ingress trait  strips `ports:`        — the proxy routes instead
 *   secrets trait  rewrites `environment:` — the value arrives as process env
 *   THIS stage     strips `build:`         — the image is produced before deploy
 *
 * ⚠️ THE UPSTREAM COMPOSE KEEPS ITS `build:` BLOCK. It stays a valid compose file that a
 * human can read and `docker compose build` by hand. What changes is the RENDER, which is
 * already appbay's editorialised artifact rather than a copy of the input.
 *
 * 🚨 WHY STRIP RATHER THAN LEAVE IT: a render carrying `build:` puts an implicit image
 * build inside `compose up`. On podman's compat API that is the least-tested path in this
 * stack — measured 2026-08-07: docker-compose against podman failing at image RESOLUTION,
 * reporting `no such image` for an image podman demonstrably held. After hoisting, deploy
 * is a pure "run this image" and the build is a step that already succeeded and was
 * verified.
 *
 * The consequence to respect: stripping means the image MUST exist by deploy time. That is
 * why `runBuildAction` is not best-effort and why a failed `verify` blocks.
 */

import { spawnSync } from "node:child_process";
import type { BuildSpec } from "../schemas/appbay-yaml.js";
import type { ShepherdAction } from "../traits/types.js";
import { containerBin } from "../runtime/container-runtime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One resolved build, ready to run before deploy. */
export interface ResolvedBuild {
  service: string;
  image: string;
  /** Build context, relative to the app directory. */
  context: string;
  /** Dockerfile path, relative to the context. */
  dockerfile?: string;
  /** Build args, flattened from the compose `build.args` mapping. */
  args: Record<string, string>;
  verify?: BuildSpec["verify"];
  pullIfPresent?: string;
}

export interface ResolveBuildsResult {
  compose: Record<string, unknown>;
  builds: ResolvedBuild[];
  /** Fatal problems — a service that would deploy with no usable image. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Resolution (pure — no filesystem, no spawning)
// ---------------------------------------------------------------------------

/** Does an instance-config predicate hold? All keys must match, compared as strings. */
export function buildApplies(
  spec: BuildSpec,
  instanceConfig: Record<string, unknown>,
): boolean {
  if (!spec.when) return true;
  return Object.entries(spec.when.instance).every(
    ([key, want]) => String(instanceConfig[key] ?? "") === want,
  );
}

/**
 * Hoist every `build:` out of the compose, pinning images and stripping the blocks.
 *
 * ⚠️ `build:` is stripped whether or not the build APPLIES. A service whose build is gated
 * off by `when:` falls back to the `image:` already in the compose — which is exactly what
 * `image: ${VAR:-default}` is for. Leaving the block in that case would reintroduce the
 * implicit-build path for precisely the installations that opted out of building.
 */
export function resolveBuilds(
  compose: Record<string, unknown>,
  specs: Record<string, BuildSpec> | undefined,
  instanceConfig: Record<string, unknown>,
): ResolveBuildsResult {
  const result = structuredClone(compose);
  const services = result.services as Record<string, Record<string, unknown>> | undefined;
  const builds: ResolvedBuild[] = [];
  const errors: string[] = [];

  if (!services) return { compose: result, builds, errors };

  for (const [name, svc] of Object.entries(services)) {
    const raw = svc.build;
    if (raw === undefined) continue;

    // Compose allows the short form `build: ./dir` as well as the long mapping form.
    const spec = specs?.[name];
    const long = typeof raw === "string" ? { context: raw } : (raw as Record<string, unknown>);

    delete svc.build;

    if (!spec) {
      // A compose that builds, with no manifest policy for it. Stripping alone would leave
      // a service pointing at an image nobody produces, so this is an error rather than a
      // silent fallback — the fallback IS the bug class this stage exists to remove.
      if (typeof svc.image !== "string" || !svc.image) {
        errors.push(
          `service "${name}" declares build: but the manifest has no builds.${name} entry ` +
            `and the service sets no image:. Add builds.${name}.image so appbay knows what ` +
            `to produce, or remove the build block.`,
        );
      }
      continue;
    }

    if (!buildApplies(spec, instanceConfig)) {
      // Gated off — the compose's own image: stands.
      continue;
    }

    svc.image = spec.image;
    builds.push({
      service: name,
      image: spec.image,
      context: typeof long.context === "string" ? long.context : ".",
      dockerfile: typeof long.dockerfile === "string" ? long.dockerfile : undefined,
      args: normaliseArgs(long.args),
      verify: spec.verify,
      pullIfPresent: spec.pull_if_present,
    });
  }

  return { compose: result, builds, errors };
}

/** Compose accepts build args as a mapping or a `KEY=value` list. Normalise to a mapping. */
function normaliseArgs(args: unknown): Record<string, string> {
  if (!args) return {};
  if (Array.isArray(args)) {
    const out: Record<string, string> = {};
    for (const entry of args) {
      if (typeof entry !== "string") continue;
      const eq = entry.indexOf("=");
      if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  }
  if (typeof args === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      out[k] = String(v ?? "");
    }
    return out;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Execution — a pre-deploy shepherd action per resolved build
// ---------------------------------------------------------------------------

/**
 * Turn a resolved build into the pre-deploy action that produces and checks the image.
 *
 * Order, and each step exists for a measured reason:
 *   1. pull_if_present    -> pull and retag. The escape hatch for hosts that must not build.
 *   2. build              -> plain `build`, NOT buildx: buildx drives the daemon's BuildKit
 *                            gRPC endpoints and podman serves the classic POST /build with
 *                            no BuildKit. `podman build` uses buildah and handles
 *                            multi-stage natively; `docker build` handles it too.
 *   3. verify             -> run the declared command IN the image and check the output.
 *
 * ⚠️ There is deliberately no "image already present -> skip" step. It existed, it keyed
 * on the TAG rather than the context, and it meant changed source never rebuilt (#77).
 * Caching belongs to the builder, whose key is the content.
 *
 * 🚨 STEP 4 BLOCKS. A build can succeed and still produce an image that cannot do the job —
 * a Caddy without its DNS module compiles, runs, serves, and quietly issues certificates
 * from its internal CA forever. Failing the deploy is the only outcome that surfaces that.
 */
export function buildShepherdAction(build: ResolvedBuild, appDir: string): ShepherdAction {
  return {
    phase: "pre-deploy",
    label: `Build ${build.image} for service ${build.service}`,
    timeoutMs: 1_800_000,
    run: async () => {
      const bin = containerBin();

      // 🚨 THERE IS NO PRESENCE CHECK HERE, AND THAT IS THE FIX (#77).
      //
      // This used to `image inspect` the tag and skip the build when it resolved, on the
      // stated grounds that "builds are expensive and idempotence is the whole point".
      // That conflated two different things. Idempotence is same-input-same-output;
      // presence is only that a NAME resolves. `:1` is a string someone typed — it says
      // nothing about the bytes underneath it, so editing the source and re-converging
      // changed nothing and reported nothing. The only way to get changed source built
      // was `podman rmi` by hand.
      //
      // Worse, `verifyOrThrow` then ran against the stale image and PASSED, because a
      // stale image is usually a working image. The one check placed to catch a wrong
      // artifact instead certified it, on every converge, indefinitely.
      //
      // Nothing is lost by always invoking the builder: `podman build`/`docker build`
      // already skip unchanged layers, and their cache key is derived from the context
      // rather than from a name. A no-op rebuild against a warm layer cache is cheap; a
      // silently stale image is not.
      if (build.pullIfPresent) {
        const pull = spawnSync(bin, ["pull", build.pullIfPresent], {
          stdio: ["pipe", "pipe", "pipe"],
          encoding: "utf-8",
        });
        if (pull.status === 0) {
          spawnSync(bin, ["tag", build.pullIfPresent, build.image], {
            stdio: ["pipe", "pipe", "pipe"],
          });
          verifyOrThrow(bin, build);
          return { built: false, reason: `pulled ${build.pullIfPresent}` };
        }
        // Pull failed — fall through and build. Recorded rather than fatal: the escape
        // hatch is a preference, and a host that CAN build should not be blocked by a
        // registry being unreachable.
        console.log(`    Could not pull ${build.pullIfPresent}; building instead.`);
      }

      const args: string[] = ["build", "-t", build.image];
      if (build.dockerfile) args.push("-f", build.dockerfile);
      for (const [k, v] of Object.entries(build.args)) args.push("--build-arg", `${k}=${v}`);
      args.push(build.context);

      console.log(`    Building ${build.image} (this can take several minutes)...`);
      const result = spawnSync(bin, args, {
        cwd: appDir,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
      });
      if (result.status !== 0) {
        const tail = String(result.stderr ?? "").trim().split("\n").slice(-6).join("\n");
        throw new Error(`build failed for ${build.image}:\n${tail}`);
      }

      verifyOrThrow(bin, build);
      return { built: true, image: build.image };
    },
  };
}

function verifyOrThrow(bin: string, build: ResolvedBuild): void {
  if (!build.verify) return;
  const [cmd, ...rest] = build.verify.command;
  const check = spawnSync(bin, ["run", "--rm", "--entrypoint", cmd, build.image, ...rest], {
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
  });
  const output = `${check.stdout ?? ""}${check.stderr ?? ""}`;
  assertVerificationResult(build, check.status, output);
}

/**
 * Interpret an image capability probe without conflating execution failures with a
 * successful command whose inventory is incomplete.
 */
export function assertVerificationResult(
  build: ResolvedBuild,
  status: number | null,
  output: string,
): void {
  if (!build.verify) return;
  if (status !== 0) {
    const detail = output.trim().split("\n").slice(-4).join("\n");
    throw new Error(
      `${build.image} could not run its declared check ` +
        `("${build.verify.command.join(" ")}", exit ${status ?? "unknown"}).` +
        `${detail ? `\n${detail}` : ""}\n` +
        `Confirm the configured container_runtime can see the image it just built.`,
    );
  }
  const required = Array.isArray(build.verify.contains)
    ? build.verify.contains
    : [build.verify.contains];
  const missing = required.filter((claim) => !output.includes(claim));
  if (missing.length > 0) {
    throw new Error(
      `${build.image} failed its declared check: running "${build.verify.command.join(" ")}" ` +
        `did not produce ${missing.map((claim) => `"${claim}"`).join(", ")}.\n` +
        `This image cannot do what the app needs. Deploying it would look healthy and ` +
        `silently do the wrong thing, so the deploy is refused.`,
    );
  }
}
