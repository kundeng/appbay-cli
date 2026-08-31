import { describe, it, expect } from "vitest";
import { hooksTraitDefinition, hookServiceName, hookConfigName } from "../hooks.js";
import type { TraitTransformInput, CompilerContext } from "../../types.js";
import type { HooksTrait } from "../../../schemas/appbay-yaml.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<CompilerContext>): CompilerContext {
  return {
    namespace: "default",
    appName: "myapp",
    appsDir: "/tmp/apps",
    runtimeFacts: {
      gpu: { available: false, cdiSupported: false },
      docker: { version: "24.0.0", composeVersion: "2.20.0", socketPath: "/var/run/docker.sock" },
      os: { platform: "linux", arch: "x64", version: "6.0" },
      disk: { availableGb: 100, totalGb: 500 },
      operatorId: "test-operator",
    },
    ...overrides,
  };
}

function makeInput(
  props: HooksTrait,
  overrides?: Partial<TraitTransformInput>,
): TraitTransformInput {
  return {
    app: "myapp",
    // Traits under test read siblings via input.siblingTraits; default to none.
    siblingTraits: [],
    service: "web",
    properties: props,
    compose: {
      services: {
        web: {
          image: "nginx:latest",
        },
      },
    },
    context: makeContext(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hooksTraitDefinition", () => {
  it("has the correct type, scope, and category", () => {
    expect(hooksTraitDefinition.type).toBe("hooks");
    expect(hooksTraitDefinition.scope).toBe("service");
    expect(hooksTraitDefinition.category).toBe("core");
  });

  it("validates valid hooks properties for init pattern", () => {
    const result = hooksTraitDefinition.schema.safeParse({
      type: "hooks",
      pattern: "init",
      image: "alpine:latest",
      command: "echo hello",
    });
    expect(result.success).toBe(true);
  });

  it("validates valid hooks properties for sidecar pattern", () => {
    const result = hooksTraitDefinition.schema.safeParse({
      type: "hooks",
      pattern: "sidecar",
      image: "fluentd:latest",
    });
    expect(result.success).toBe(true);
  });

  it("validates valid hooks properties for config pattern", () => {
    const result = hooksTraitDefinition.schema.safeParse({
      type: "hooks",
      pattern: "config",
      content: "key=value",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid pattern value", () => {
    const result = hooksTraitDefinition.schema.safeParse({
      type: "hooks",
      pattern: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("hooks transform - init pattern", () => {
  it("creates a one-shot init service with restart: no", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "init",
      image: "alpine:latest",
      command: "sh -c 'echo init done'",
    };
    const output = hooksTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<string, Record<string, unknown>>;
    const initSvc = services["myapp-web-init-hook"];

    expect(initSvc).toBeDefined();
    expect(initSvc.image).toBe("alpine:latest");
    expect(initSvc.command).toBe("sh -c 'echo init done'");
    expect(initSvc.restart).toBe("no");
  });

  it("adds depends_on with service_completed_successfully to target service", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "init",
      image: "alpine:latest",
      command: "echo hello",
    };
    const output = hooksTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<string, Record<string, unknown>>;
    const dependsOn = services.web.depends_on as Record<string, Record<string, string>>;

    expect(dependsOn["myapp-web-init-hook"]).toEqual({
      condition: "service_completed_successfully",
    });
  });

  it("defaults to busybox:latest if no image specified", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "init",
      command: "echo hello",
    };
    const output = hooksTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<string, Record<string, unknown>>;
    expect(services["myapp-web-init-hook"].image).toBe("busybox:latest");
  });

  it("includes volumes when specified", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "init",
      image: "alpine:latest",
      volumes: ["/data:/data", "/config:/config"],
    };
    const output = hooksTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<string, Record<string, unknown>>;
    expect(services["myapp-web-init-hook"].volumes).toEqual(["/data:/data", "/config:/config"]);
  });
});

describe("hooks transform - sidecar pattern", () => {
  it("creates a long-running sidecar service with restart: unless-stopped", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "sidecar",
      image: "fluentd:latest",
      command: "fluentd -c /etc/fluent.conf",
      volumes: ["/var/log:/var/log"],
    };
    const output = hooksTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<string, Record<string, unknown>>;
    const sidecarSvc = services["myapp-web-sidecar-hook"];

    expect(sidecarSvc).toBeDefined();
    expect(sidecarSvc.image).toBe("fluentd:latest");
    expect(sidecarSvc.command).toBe("fluentd -c /etc/fluent.conf");
    expect(sidecarSvc.restart).toBe("unless-stopped");
    expect(sidecarSvc.volumes).toEqual(["/var/log:/var/log"]);
  });

  it("does not add depends_on to the target service", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "sidecar",
      image: "fluentd:latest",
    };
    const output = hooksTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<string, Record<string, unknown>>;
    // The target service should not have a depends_on for the sidecar
    expect(services.web.depends_on).toBeUndefined();
  });
});

describe("hooks transform - config pattern", () => {
  it("creates a top-level Compose config with inline content", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "config",
      content: "server {\n  listen 80;\n}",
    };
    const output = hooksTraitDefinition.transform(makeInput(props));

    const configs = output.compose.configs as Record<string, Record<string, unknown>>;
    const configEntry = configs["myapp-web-hook-config"];

    expect(configEntry).toBeDefined();
    expect(configEntry.content).toBe("server {\n  listen 80;\n}");
  });

  it("mounts the config into the target service", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "config",
      content: "key=value",
    };
    const output = hooksTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<string, Record<string, unknown>>;
    const svcConfigs = services.web.configs as Array<Record<string, string>>;

    expect(svcConfigs).toBeDefined();
    expect(svcConfigs.length).toBe(1);
    expect(svcConfigs[0].source).toBe("myapp-web-hook-config");
    expect(svcConfigs[0].target).toBe("/myapp-web-hook-config");
  });

  it("does not create additional service containers", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "config",
      content: "setting=true",
    };
    const output = hooksTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<string, Record<string, unknown>>;
    // Only the original 'web' service should exist
    expect(Object.keys(services)).toEqual(["web"]);
  });

  it("defaults to empty string content when not provided", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "config",
    };
    const output = hooksTraitDefinition.transform(makeInput(props));

    const configs = output.compose.configs as Record<string, Record<string, unknown>>;
    expect(configs["myapp-web-hook-config"].content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// init pattern — service = undefined (no depends_on wiring)
// ---------------------------------------------------------------------------

describe("hooks transform - init pattern (no target service)", () => {
  it("creates the init hook service without wiring depends_on when service is undefined", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "init",
      image: "alpine:latest",
      command: "echo setup",
    };
    const input = makeInput(props, {
      service: undefined,
      compose: { services: { web: { image: "nginx:latest" } } },
    });
    const output = hooksTraitDefinition.transform(input);

    const services = output.compose.services as Record<string, Record<string, unknown>>;
    // Init hook is created.
    expect(services["myapp-init-hook"]).toBeDefined();
    expect(services["myapp-init-hook"].image).toBe("alpine:latest");
    // The existing service is NOT mutated with depends_on.
    expect(services.web?.depends_on).toBeUndefined();
  });

  it("does not add volumes to init hook when volumes array is empty", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "init",
      image: "alpine:latest",
      volumes: [],
    };
    const output = hooksTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<string, Record<string, unknown>>;
    expect(services["myapp-web-init-hook"].volumes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// config pattern — service = undefined (no service mounting)
// ---------------------------------------------------------------------------

describe("hooks transform - config pattern (no target service)", () => {
  it("creates the config entry without mounting when service is undefined", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "config",
      content: "server { listen 80; }",
    };
    const input = makeInput(props, {
      service: undefined,
      compose: { services: { web: { image: "nginx:latest" } } },
    });
    const output = hooksTraitDefinition.transform(input);

    // Config is created in the top-level configs section.
    const configs = output.compose.configs as Record<string, Record<string, unknown>>;
    expect(configs["myapp-hook-config"]).toBeDefined();
    expect(configs["myapp-hook-config"].content).toBe("server { listen 80; }");

    // The existing web service is NOT mutated (no configs mount).
    const services = output.compose.services as Record<string, Record<string, unknown>>;
    expect(services.web?.configs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sidecar pattern — volumes empty array (no volumes added)
// ---------------------------------------------------------------------------

describe("hooks transform - sidecar pattern (empty volumes)", () => {
  it("does not add volumes to sidecar when volumes array is empty", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "sidecar",
      image: "fluentd:latest",
      volumes: [],
    };
    const output = hooksTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<string, Record<string, unknown>>;
    expect(services["myapp-web-sidecar-hook"].volumes).toBeUndefined();
  });
});

describe("hooks service naming", () => {
  it("namespaces hook services with app and service name", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "init",
      image: "alpine:latest",
    };
    const output = hooksTraitDefinition.transform(makeInput(props));

    const services = output.compose.services as Record<string, unknown>;
    expect(services["myapp-web-init-hook"]).toBeDefined();
  });

  it("uses app name only when no service is specified", () => {
    const props: HooksTrait = {
      type: "hooks",
      pattern: "sidecar",
      image: "fluentd:latest",
    };
    const input = makeInput(props, { service: undefined });
    const output = hooksTraitDefinition.transform(input);

    const services = output.compose.services as Record<string, unknown>;
    expect(services["myapp-sidecar-hook"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// hookServiceName helper
// ---------------------------------------------------------------------------

describe("hookServiceName", () => {
  it("returns '<app>-<pattern>-hook' when no service given", () => {
    expect(hookServiceName("myapp", undefined, "init")).toBe("myapp-init-hook");
  });

  it("returns '<app>-<service>-<pattern>-hook' when service is given", () => {
    expect(hookServiceName("myapp", "web", "init")).toBe("myapp-web-init-hook");
  });

  it("works with 'sidecar' pattern", () => {
    expect(hookServiceName("myapp", "db", "sidecar")).toBe("myapp-db-sidecar-hook");
  });

  it("works with 'config' pattern", () => {
    expect(hookServiceName("myapp", undefined, "config")).toBe("myapp-config-hook");
  });

  it("preserves hyphenated app names", () => {
    expect(hookServiceName("open-webui", "web", "init")).toBe("open-webui-web-init-hook");
  });

  it("handles different app and service combinations", () => {
    expect(hookServiceName("ollama", "api", "sidecar")).toBe("ollama-api-sidecar-hook");
  });
});

// ---------------------------------------------------------------------------
// hookConfigName helper
// ---------------------------------------------------------------------------

describe("hookConfigName", () => {
  it("returns '<app>-hook-config' when no service given", () => {
    expect(hookConfigName("myapp", undefined)).toBe("myapp-hook-config");
  });

  it("returns '<app>-<service>-hook-config' when service is given", () => {
    expect(hookConfigName("myapp", "web")).toBe("myapp-web-hook-config");
  });

  it("handles different app names", () => {
    expect(hookConfigName("caddy", "server")).toBe("caddy-server-hook-config");
  });

  it("handles hyphenated app names", () => {
    expect(hookConfigName("open-webui", undefined)).toBe("open-webui-hook-config");
  });
});

// ---------------------------------------------------------------------------
// Volume namespacing (issue #56)
// ---------------------------------------------------------------------------

describe("hook volumes are namespaced like every other volume", () => {
  // 🚨 The upstream transform prefixes named volumes with the app name for namespace
  // isolation, but the hooks trait used to copy `props.volumes` verbatim. The hook then
  // referenced `ha-config` while the project defined `homeassistant_ha-config`, and
  // compose rejected the WHOLE project:
  //
  //   service "homeassistant-init-hook" refers to undefined volume ha-config
  //
  // That was then "fixed" by deleting the `:/config` mount path from the manifest, which
  // made compose happy by turning the reference into an ANONYMOUS volume — so the hook
  // mounted nothing, chowned its own ephemeral directory, and reported success. A green
  // no-op is worse than the error it replaced.
  it("prefixes a named volume with the app name", () => {
    const out = hooksTraitDefinition.transform(
      makeInput({ type: "hooks", pattern: "init", image: "busybox:latest", volumes: ["ha-config:/config"] }),
    );
    const hook = (out.compose.services as Record<string, { volumes?: string[] }>)["myapp-web-init-hook"];
    expect(hook?.volumes).toEqual(["myapp_ha-config:/config"]);
  });

  it("leaves absolute bind mounts alone", () => {
    const out = hooksTraitDefinition.transform(
      makeInput({ type: "hooks", pattern: "init", image: "busybox:latest", volumes: ["/etc/localtime:/etc/localtime:ro"] }),
    );
    const hook = (out.compose.services as Record<string, { volumes?: string[] }>)["myapp-web-init-hook"];
    expect(hook?.volumes).toEqual(["/etc/localtime:/etc/localtime:ro"]);
  });

  it("leaves relative bind mounts alone", () => {
    const out = hooksTraitDefinition.transform(
      makeInput({ type: "hooks", pattern: "init", image: "busybox:latest", volumes: ["./config:/config"] }),
    );
    const hook = (out.compose.services as Record<string, { volumes?: string[] }>)["myapp-web-init-hook"];
    expect(hook?.volumes).toEqual(["./config:/config"]);
  });

  it("does not double-prefix an already-namespaced volume", () => {
    const out = hooksTraitDefinition.transform(
      makeInput({ type: "hooks", pattern: "init", image: "busybox:latest", volumes: ["myapp_ha-config:/config"] }),
    );
    const hook = (out.compose.services as Record<string, { volumes?: string[] }>)["myapp-web-init-hook"];
    expect(hook?.volumes).toEqual(["myapp_ha-config:/config"]);
  });
});
