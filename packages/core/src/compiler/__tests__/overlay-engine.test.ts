import { describe, it, expect } from "vitest";
import {
  selectActiveOverlays,
  mergeOverlays,
} from "../overlay-engine.js";
import type { OverlayInput } from "../overlay-engine.js";

// ---------------------------------------------------------------------------
// 1. AND clause met -- all apps active -> overlay selected
// ---------------------------------------------------------------------------

describe("selectActiveOverlays", () => {
  it("selects overlay when AND clause is met (all apps installed)", () => {
    const input: OverlayInput = {
      overlays: [
        {
          when: ["ollama", "whisper"],
          services: {
            webui: { environment: ["OPENAI_API_BASE=http://ollama:11434/v1"] },
          },
        },
      ],
      installedApps: new Set(["ollama", "whisper", "webui"]),
    };

    const result = selectActiveOverlays(input);

    expect(result.activeOverlays).toHaveLength(1);
    expect(result.inactiveOverlays).toHaveLength(0);
    expect(result.activeOverlays[0].when).toEqual(["ollama", "whisper"]);
  });

  // -------------------------------------------------------------------------
  // 2. AND clause not met -- one app not installed -> overlay excluded
  // -------------------------------------------------------------------------

  it("excludes overlay when AND clause is not met (one app not installed)", () => {
    const input: OverlayInput = {
      overlays: [
        {
          when: ["ollama", "whisper"],
          services: {
            webui: { environment: ["OPENAI_API_BASE=http://ollama:11434/v1"] },
          },
        },
      ],
      installedApps: new Set(["ollama"]),
    };

    const result = selectActiveOverlays(input);

    expect(result.activeOverlays).toHaveLength(0);
    expect(result.inactiveOverlays).toHaveLength(1);
    expect(result.inactiveOverlays[0].reason).toContain("whisper");
  });

  // -------------------------------------------------------------------------
  // 3. OR clause met -- one of several active -> overlay selected
  // -------------------------------------------------------------------------

  it("selects overlay when OR clause is met (one of several installed)", () => {
    const input: OverlayInput = {
      overlays: [
        {
          when: { any: ["tts", "stt"] },
          services: {
            webui: { environment: ["AUDIO_ENABLED=true"] },
          },
        },
      ],
      installedApps: new Set(["stt"]),
    };

    const result = selectActiveOverlays(input);

    expect(result.activeOverlays).toHaveLength(1);
    expect(result.inactiveOverlays).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. OR clause not met -- none installed -> overlay excluded
  // -------------------------------------------------------------------------

  it("excludes overlay when OR clause is not met (none installed)", () => {
    const input: OverlayInput = {
      overlays: [
        {
          when: { any: ["tts", "stt"] },
          services: {
            webui: { environment: ["AUDIO_ENABLED=true"] },
          },
        },
      ],
      installedApps: new Set(["ollama"]),
    };

    const result = selectActiveOverlays(input);

    expect(result.activeOverlays).toHaveLength(0);
    expect(result.inactiveOverlays).toHaveLength(1);
    expect(result.inactiveOverlays[0].reason).toContain("tts");
    expect(result.inactiveOverlays[0].reason).toContain("stt");
  });

  // -------------------------------------------------------------------------
  // 5. Multiple overlays -- only matching ones selected
  // -------------------------------------------------------------------------

  it("selects only matching overlays from a mixed set", () => {
    const input: OverlayInput = {
      overlays: [
        {
          when: ["ollama"],
          services: { webui: { environment: ["LLM=ollama"] } },
        },
        {
          when: { any: ["tts", "stt"] },
          services: { webui: { environment: ["AUDIO=true"] } },
        },
        {
          when: ["missing-app"],
          services: { webui: { environment: ["SHOULD_NOT=appear"] } },
        },
      ],
      installedApps: new Set(["ollama", "tts"]),
    };

    const result = selectActiveOverlays(input);

    expect(result.activeOverlays).toHaveLength(2);
    expect(result.inactiveOverlays).toHaveLength(1);
    expect(result.inactiveOverlays[0].reason).toContain("missing-app");
  });

  // -------------------------------------------------------------------------
  // 9. Empty overlays list -> no changes
  // -------------------------------------------------------------------------

  it("returns empty results for an empty overlays list", () => {
    const input: OverlayInput = {
      overlays: [],
      installedApps: new Set(["anything"]),
    };

    const result = selectActiveOverlays(input);

    expect(result.activeOverlays).toHaveLength(0);
    expect(result.inactiveOverlays).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Edge: empty AND clause -> trivially satisfied (no requirements)
  // -------------------------------------------------------------------------

  it("selects overlay with empty AND clause (trivially satisfied)", () => {
    const input: OverlayInput = {
      overlays: [
        {
          when: [],
          services: { webui: { environment: ["ALWAYS=true"] } },
        },
      ],
      installedApps: new Set(),
    };

    const result = selectActiveOverlays(input);

    // Empty AND = "all of zero requirements met" = always active.
    expect(result.activeOverlays).toHaveLength(1);
    expect(result.inactiveOverlays).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Edge: empty OR clause -> never satisfied
  // -------------------------------------------------------------------------

  it("excludes overlay with empty OR clause (never satisfied)", () => {
    const input: OverlayInput = {
      overlays: [
        {
          when: { any: [] },
          services: { webui: { environment: ["NEVER=true"] } },
        },
      ],
      installedApps: new Set(["any-app"]),
    };

    const result = selectActiveOverlays(input);

    // Empty any = "at least one of zero" = never active.
    expect(result.activeOverlays).toHaveLength(0);
    expect(result.inactiveOverlays).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// mergeOverlays
// ---------------------------------------------------------------------------

describe("mergeOverlays", () => {
  // -------------------------------------------------------------------------
  // 6. mergeOverlays appends environment arrays
  // -------------------------------------------------------------------------

  it("appends environment arrays from overlay into base", () => {
    const base = {
      webui: {
        image: "webui:latest",
        environment: ["PORT=3000"],
      },
    };
    const overlays = [
      {
        services: {
          webui: {
            environment: ["OPENAI_API_BASE=http://ollama:11434/v1"],
          },
        },
      },
    ];

    const result = mergeOverlays(base, overlays);

    expect(result.webui.environment).toEqual([
      "PORT=3000",
      "OPENAI_API_BASE=http://ollama:11434/v1",
    ]);
  });

  // -------------------------------------------------------------------------
  // 7. mergeOverlays appends volumes arrays
  // -------------------------------------------------------------------------

  it("appends volumes arrays from overlay into base", () => {
    const base = {
      app: {
        image: "app:latest",
        volumes: ["/data:/data"],
      },
    };
    const overlays = [
      {
        services: {
          app: {
            volumes: ["/models:/models"],
          },
        },
      },
    ];

    const result = mergeOverlays(base, overlays);

    expect(result.app.volumes).toEqual(["/data:/data", "/models:/models"]);
  });

  // -------------------------------------------------------------------------
  // 8. mergeOverlays scalar override
  // -------------------------------------------------------------------------

  it("overrides scalar values with overlay value", () => {
    const base = {
      webui: {
        image: "webui:v1",
        restart: "unless-stopped",
      },
    };
    const overlays = [
      {
        services: {
          webui: {
            image: "webui:v2-gpu",
          },
        },
      },
    ];

    const result = mergeOverlays(base, overlays);

    expect(result.webui.image).toBe("webui:v2-gpu");
    // Unchanged scalar is preserved.
    expect(result.webui.restart).toBe("unless-stopped");
  });

  // -------------------------------------------------------------------------
  // 9. Empty overlays list -> no changes
  // -------------------------------------------------------------------------

  it("returns base services unchanged when overlays list is empty", () => {
    const base = {
      webui: {
        image: "webui:latest",
        environment: ["PORT=3000"],
      },
    };

    const result = mergeOverlays(base, []);

    expect(result).toEqual(base);
  });

  // -------------------------------------------------------------------------
  // 10. Overlay targeting non-existent service -> added as new service
  // -------------------------------------------------------------------------

  it("adds a new service fragment when overlay targets non-existent service", () => {
    const base = {
      webui: { image: "webui:latest" },
    };
    const overlays = [
      {
        services: {
          sidecar: {
            image: "sidecar:latest",
            environment: ["MODE=proxy"],
          },
        },
      },
    ];

    const result = mergeOverlays(base, overlays);

    expect(result.sidecar).toBeDefined();
    expect(result.sidecar.image).toBe("sidecar:latest");
    expect(result.sidecar.environment).toEqual(["MODE=proxy"]);
    // Base service is preserved.
    expect(result.webui.image).toBe("webui:latest");
  });

  // -------------------------------------------------------------------------
  // Extra: labels and depends_on merge as objects
  // -------------------------------------------------------------------------

  it("merges labels and depends_on objects (overlay wins on conflict)", () => {
    const base = {
      webui: {
        labels: { "traefik.enable": "true", "app.tier": "frontend" },
        depends_on: { db: { condition: "service_healthy" } },
      },
    };
    const overlays = [
      {
        services: {
          webui: {
            labels: { "traefik.enable": "false", "app.gpu": "true" },
            depends_on: { redis: { condition: "service_started" } },
          },
        },
      },
    ];

    const result = mergeOverlays(base, overlays);

    // Labels: overlay overrides "traefik.enable", adds "app.gpu", preserves "app.tier".
    expect(result.webui.labels).toEqual({
      "traefik.enable": "false",
      "app.tier": "frontend",
      "app.gpu": "true",
    });

    // depends_on: both entries present.
    expect(result.webui.depends_on).toEqual({
      db: { condition: "service_healthy" },
      redis: { condition: "service_started" },
    });
  });

  // -------------------------------------------------------------------------
  // Extra: ports array append
  // -------------------------------------------------------------------------

  it("appends ports arrays from overlay into base", () => {
    const base = {
      webui: { ports: ["8080:8080"] },
    };
    const overlays = [
      {
        services: {
          webui: { ports: ["9090:9090"] },
        },
      },
    ];

    const result = mergeOverlays(base, overlays);

    expect(result.webui.ports).toEqual(["8080:8080", "9090:9090"]);
  });

  // -------------------------------------------------------------------------
  // Extra: does not mutate the input base object
  // -------------------------------------------------------------------------

  it("does not mutate the input base services object", () => {
    const base = {
      webui: {
        image: "webui:v1",
        environment: ["PORT=3000"],
      },
    };
    const originalEnv = [...(base.webui.environment as string[])];

    mergeOverlays(base, [
      {
        services: {
          webui: {
            image: "webui:v2",
            environment: ["EXTRA=1"],
          },
        },
      },
    ]);

    // Original base must be unchanged.
    expect(base.webui.image).toBe("webui:v1");
    expect(base.webui.environment).toEqual(originalEnv);
  });

  // -------------------------------------------------------------------------
  // Coercion: non-array base coerced to [] for append-array keys
  // -------------------------------------------------------------------------

  it("coerces missing base environment to [] before appending overlay", () => {
    // Service with no environment key — overlay should create it.
    const base = { svc: { image: "alpine:latest" } };
    const result = mergeOverlays(base, [
      { services: { svc: { environment: ["NEW_VAR=1"] } } },
    ]);
    expect(result.svc.environment).toEqual(["NEW_VAR=1"]);
  });

  it("coerces missing base labels to {} before merging overlay labels", () => {
    const base = { svc: { image: "alpine:latest" } };
    const result = mergeOverlays(base, [
      { services: { svc: { labels: { "traefik.enable": "true" } } } },
    ]);
    expect(result.svc.labels).toEqual({ "traefik.enable": "true" });
  });

  it("merges two overlays sequentially (later overlay wins on scalar conflict)", () => {
    const base = { svc: { image: "app:v1", environment: ["A=1"] } };
    const result = mergeOverlays(base, [
      { services: { svc: { image: "app:v2", environment: ["B=2"] } } },
      { services: { svc: { image: "app:v3", environment: ["C=3"] } } },
    ]);
    // Later overlay wins for scalars.
    expect(result.svc.image).toBe("app:v3");
    // Arrays are accumulated across both overlays.
    expect(result.svc.environment).toEqual(["A=1", "B=2", "C=3"]);
  });

  // -------------------------------------------------------------------------
  // Recursive nested object merge (non-special keys like networks, healthcheck)
  // -------------------------------------------------------------------------

  it("recursively merges nested plain objects for non-special keys (e.g. networks)", () => {
    // "networks" is not in APPEND_ARRAY_KEYS or MERGE_OBJECT_KEYS, so when both
    // base and overlay values are plain objects, mergeServiceFragment recurses.
    const base = {
      webui: {
        networks: {
          app_net: { aliases: ["webui"] },
          db_net: { aliases: ["db-client"] },
        },
      },
    };
    const overlays = [
      {
        services: {
          webui: {
            networks: {
              // Overlay adds a new network key and overrides a scalar inside app_net.
              app_net: { priority: 10 },
              shared_net: { aliases: ["shared-webui"] },
            },
          },
        },
      },
    ];

    const result = mergeOverlays(base, overlays);
    const networks = result.webui.networks as Record<string, unknown>;

    // app_net: recursively merged — base has "aliases", overlay adds "priority".
    expect((networks.app_net as Record<string, unknown>).aliases).toEqual(["webui"]);
    expect((networks.app_net as Record<string, unknown>).priority).toBe(10);

    // db_net: only in base — preserved unchanged.
    expect((networks.db_net as Record<string, unknown>).aliases).toEqual(["db-client"]);

    // shared_net: only in overlay — added as-is.
    expect((networks.shared_net as Record<string, unknown>).aliases).toEqual(["shared-webui"]);
  });

  it("uses overlay value as-is when base has a non-object for a non-special key", () => {
    // Base has a scalar for "image" (already covered) but here we test the case
    // where base has a plain object and overlay has a scalar — overlay wins.
    const base = {
      svc: {
        deploy: { replicas: 1, resources: { limits: { cpus: "0.5" } } },
      },
    };
    const overlays = [
      {
        services: {
          svc: {
            // Overlay replaces the entire deploy block with a scalar (unusual but valid).
            deploy: "null" as unknown as Record<string, unknown>,
          },
        },
      },
    ];

    const result = mergeOverlays(base, overlays);
    // Overlay value wins (scalar override path: base is object, overlay is not).
    expect(result.svc.deploy).toBe("null");
  });
});
