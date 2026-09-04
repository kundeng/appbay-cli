/**
 * Current version.
 *
 * This package builds with plain `tsc`, which strips types but does NOT inline
 * environment variables — so this expression survives into `dist/` as a RUNTIME
 * read. Setting `APPBAY_VERSION` during the build therefore does nothing for a
 * shipped artifact; the value has to be substituted by the bundler that
 * produces the binary.
 *
 * `release.yml` does that with `bun build --define`. Anything else that ships
 * this code must do the same, or it will report the fallback below. Four alpha
 * releases shipped reporting `0.1.0-dev` because the env var was set on the
 * build step and assumed to be enough.
 */
export const VERSION = process.env.APPBAY_VERSION || "0.1.0-dev";

// Re-export all schemas
export * from "./schemas/index.js";

// Re-export compiler pipeline
export * from "./compiler/index.js";

// Re-export trait system
export * from "./traits/index.js";

// Re-export state module (magic variable generators, generated value store)
export * from "./state/index.js";

// Re-export secrets module (URI-based secret resolution)
export * from "./secrets/index.js";

// Re-export embedded system app definitions
export * from "./system-apps.js";

// Re-export catalog discovery
export * from "./catalog/index.js";

// Re-export boot ordering
export * from "./boot-order.js";



// Re-export runtime facts detection
export * from "./runtime/facts.js";

// Re-export the container runtime resolver — the single place the container
// binary is chosen. Spawn sites must use containerBin()/containerExec(), never "docker".
export * from "./runtime/container-runtime.js";

// Re-export the rootful-podman environment. One definition shared by the systemd unit that
// runs the control plane and the doctor check that predicts whether it can — see S34.
export * from "./runtime/podman-rootful.js";

// Re-export service modules (shared business logic for CLI + tRPC)
export * from "./services/index.js";

// Re-export shepherd runner (namespace-sharing ephemeral containers)
export * from "./shepherd/index.js";
export * from "./health/checks.js";
