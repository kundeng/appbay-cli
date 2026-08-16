/**
 * Unit tests for the compose renderer's internal merge helpers.
 *
 * isPlainObject(v):
 *   - plain objects → true
 *   - arrays, null, primitives → false
 *
 * mergeServiceFragment(base, fragment):
 *   - APPEND_ARRAY_KEYS ("environment", "volumes", "ports"): fragment appends to base
 *   - MERGE_OBJECT_KEYS ("labels", "depends_on"): shallow merge, fragment wins on collision
 *   - Nested plain objects: recursively merged
 *   - Scalars (image, restart, etc.): fragment overrides base
 *   - Missing base keys: fragment value used directly
 *   - Array key present only in fragment: fragment value used
 *
 * mergeServicesInto(compose, serviceFragments):
 *   - Merges fragment into existing service
 *   - Creates new service when not present in base
 *   - Skips empty fragments
 *   - Preserves unrelated services unchanged
 *   - compose.services absent: treats as empty
 *
 * mergeComposeObjects(base, overlay):
 *   - services key: per-service deep merge
 *   - Other plain-object keys (networks, volumes): shallow merge
 *   - Scalar top-level keys: overlay overrides
 *   - new services introduced by overlay
 */

import { describe, it, expect } from "vitest";
import {
  isPlainObject,
  mergeServiceFragment,
  mergeServicesInto,
  mergeComposeObjects,
} from "../renderer.js";

// ---------------------------------------------------------------------------
// isPlainObject
// ---------------------------------------------------------------------------

describe("isPlainObject", () => {
  it("returns true for a plain object", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("returns true for an empty object", () => {
    expect(isPlainObject({})).toBe(true);
  });

  it("returns false for an array", () => {
    expect(isPlainObject([1, 2])).toBe(false);
  });

  it("returns false for null", () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isPlainObject("hello")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isPlainObject(42)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isPlainObject(undefined)).toBe(false);
  });

  it("returns false for a boolean", () => {
    expect(isPlainObject(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergeServiceFragment — APPEND_ARRAY_KEYS
// ---------------------------------------------------------------------------

describe("mergeServiceFragment — APPEND_ARRAY_KEYS", () => {
  it("appends 'environment' arrays", () => {
    const base = { environment: ["A=1"] };
    const frag = { environment: ["B=2"] };
    const result = mergeServiceFragment(base, frag);
    expect(result.environment).toEqual(["A=1", "B=2"]);
  });

  it("appends 'volumes' arrays", () => {
    const base = { volumes: ["/data:/data"] };
    const frag = { volumes: ["/tmp:/tmp"] };
    const result = mergeServiceFragment(base, frag);
    expect(result.volumes).toEqual(["/data:/data", "/tmp:/tmp"]);
  });

  it("appends 'ports' arrays", () => {
    const base = { ports: ["80:80"] };
    const frag = { ports: ["443:443"] };
    const result = mergeServiceFragment(base, frag);
    expect(result.ports).toEqual(["80:80", "443:443"]);
  });

  it("uses fragment value directly when base has no environment", () => {
    const base = {};
    const frag = { environment: ["X=1"] };
    const result = mergeServiceFragment(base, frag);
    expect(result.environment).toEqual(["X=1"]);
  });

  it("treats non-array base value as empty array for append keys", () => {
    // If base.environment is a non-array (shouldn't happen, but defensively handled)
    const base = { environment: "not-an-array" as unknown as string[] };
    const frag = { environment: ["A=1"] };
    const result = mergeServiceFragment(base, frag);
    expect(result.environment).toEqual(["A=1"]);
  });
});

// ---------------------------------------------------------------------------
// mergeServiceFragment — MERGE_OBJECT_KEYS
// ---------------------------------------------------------------------------

describe("mergeServiceFragment — MERGE_OBJECT_KEYS", () => {
  it("shallow-merges 'labels' objects", () => {
    const base = { labels: { "traefik.enable": "true" } };
    const frag = { labels: { "traefik.port": "80" } };
    const result = mergeServiceFragment(base, frag);
    expect(result.labels).toEqual({
      "traefik.enable": "true",
      "traefik.port": "80",
    });
  });

  it("fragment labels win on collision", () => {
    const base = { labels: { version: "1" } };
    const frag = { labels: { version: "2" } };
    const result = mergeServiceFragment(base, frag);
    expect((result.labels as Record<string, string>).version).toBe("2");
  });

  it("shallow-merges 'depends_on' objects", () => {
    const base = { depends_on: { db: { condition: "service_healthy" } } };
    const frag = { depends_on: { cache: { condition: "service_started" } } };
    const result = mergeServiceFragment(base, frag);
    expect(result.depends_on).toEqual({
      db: { condition: "service_healthy" },
      cache: { condition: "service_started" },
    });
  });

  it("creates labels from fragment when base has none", () => {
    const base = {};
    const frag = { labels: { key: "val" } };
    const result = mergeServiceFragment(base, frag);
    expect(result.labels).toEqual({ key: "val" });
  });
});

// ---------------------------------------------------------------------------
// mergeServiceFragment — scalars and recursion
// ---------------------------------------------------------------------------

describe("mergeServiceFragment — scalars and recursion", () => {
  it("fragment scalar overrides base scalar", () => {
    const base = { image: "nginx:1.24", restart: "unless-stopped" };
    const frag = { image: "nginx:1.25" };
    const result = mergeServiceFragment(base, frag);
    expect(result.image).toBe("nginx:1.25");
    expect(result.restart).toBe("unless-stopped");
  });

  it("adds new key from fragment when absent in base", () => {
    const base = { image: "nginx" };
    const frag = { healthcheck: { test: ["CMD", "curl", "-f", "http://localhost"] } };
    const result = mergeServiceFragment(base, frag);
    expect(result.healthcheck).toEqual(frag.healthcheck);
    expect(result.image).toBe("nginx");
  });

  it("recursively merges nested plain objects", () => {
    const base = { deploy: { resources: { limits: { cpus: "0.5" } } } };
    const frag = { deploy: { resources: { limits: { memory: "256m" } } } };
    const result = mergeServiceFragment(base, frag) as {
      deploy: { resources: { limits: Record<string, string> } };
    };
    expect(result.deploy.resources.limits.cpus).toBe("0.5");
    expect(result.deploy.resources.limits.memory).toBe("256m");
  });

  it("does not mutate the base object", () => {
    const base = { image: "nginx:1.24" };
    const frag = { image: "nginx:1.25" };
    mergeServiceFragment(base, frag);
    expect(base.image).toBe("nginx:1.24");
  });

  it("fragment scalar overrides a plain-object base value (non-recursive fallthrough)", () => {
    // base.healthcheck is a plain object; fragment.healthcheck is a scalar string.
    // Neither APPEND_ARRAY_KEYS nor MERGE_OBJECT_KEYS, and isPlainObject(fragmentValue) is false
    // → falls through to the else: result[key] = fragmentValue.
    const base = { healthcheck: { test: ["CMD", "curl", "-f", "http://localhost"] } };
    const frag = { healthcheck: "disable" };
    const result = mergeServiceFragment(
      base as Record<string, unknown>,
      frag as Record<string, unknown>,
    );
    expect(result.healthcheck).toBe("disable");
  });
});

// ---------------------------------------------------------------------------
// mergeServiceFragment — MERGE_OBJECT_KEYS with non-object fragment value
// ---------------------------------------------------------------------------

describe("mergeServiceFragment — MERGE_OBJECT_KEYS non-object fragment fallback", () => {
  it("treats non-object fragment labels as empty object (base labels preserved)", () => {
    // If labels in the fragment is not a plain object (defensive: shouldn't happen in
    // valid Compose, but the code guards with `isPlainObject(fragmentValue) ? fragmentValue : {}`).
    const base = { labels: { "traefik.enable": "true" } };
    const frag = { labels: "not-an-object" as unknown as Record<string, unknown> };
    const result = mergeServiceFragment(base, frag);
    // fragObj becomes {} → merged with baseObj → base labels preserved, nothing added.
    expect(result.labels).toEqual({ "traefik.enable": "true" });
  });

  it("treats non-object fragment depends_on as empty object (base depends_on preserved)", () => {
    const base = { depends_on: { db: { condition: "service_healthy" } } };
    const frag = { depends_on: ["db"] as unknown as Record<string, unknown> };
    const result = mergeServiceFragment(base, frag);
    // fragObj becomes {} → shallow-merged with baseObj → base depends_on preserved.
    expect(result.depends_on).toEqual({ db: { condition: "service_healthy" } });
  });
});

// ---------------------------------------------------------------------------
// mergeServicesInto
// ---------------------------------------------------------------------------

describe("mergeServicesInto", () => {
  it("merges fragment into existing service", () => {
    const compose = {
      services: { web: { image: "nginx:1.24", ports: ["80:80"] } },
    };
    const frags = { web: { ports: ["443:443"] } };
    const result = mergeServicesInto(compose, frags);
    expect((result.services as Record<string, { ports: string[] }>).web.ports).toEqual([
      "80:80",
      "443:443",
    ]);
  });

  it("creates a new service when not present in base", () => {
    const compose = { services: { web: { image: "nginx" } } };
    const frags = { db: { image: "postgres:16" } };
    const result = mergeServicesInto(compose, frags);
    const services = result.services as Record<string, Record<string, unknown>>;
    expect(services.db).toEqual({ image: "postgres:16" });
    expect(services.web).toEqual({ image: "nginx" });
  });

  it("skips empty fragments", () => {
    const compose = { services: { web: { image: "nginx" } } };
    const frags = { web: {} };
    const result = mergeServicesInto(compose, frags);
    const services = result.services as Record<string, Record<string, unknown>>;
    expect(services.web).toEqual({ image: "nginx" });
  });

  it("preserves unrelated services", () => {
    const compose = {
      services: {
        web: { image: "nginx" },
        db: { image: "postgres" },
      },
    };
    const frags = { web: { restart: "always" } };
    const result = mergeServicesInto(compose, frags);
    const services = result.services as Record<string, Record<string, unknown>>;
    expect(services.db).toEqual({ image: "postgres" });
  });

  it("handles compose with no services key", () => {
    const compose = { version: "3" };
    const frags = { web: { image: "nginx" } };
    const result = mergeServicesInto(compose, frags);
    const services = result.services as Record<string, Record<string, unknown>>;
    expect(services.web).toEqual({ image: "nginx" });
  });

  it("does not mutate the input compose object", () => {
    const compose = { services: { web: { image: "nginx" } } };
    const frags = { web: { restart: "always" } };
    mergeServicesInto(compose, frags);
    expect((compose.services as Record<string, Record<string, unknown>>).web.restart).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mergeComposeObjects
// ---------------------------------------------------------------------------

describe("mergeComposeObjects", () => {
  it("deep-merges services at per-service level", () => {
    const base = { services: { web: { image: "nginx", ports: ["80:80"] } } };
    const overlay = { services: { web: { ports: ["443:443"] } } };
    const result = mergeComposeObjects(base, overlay);
    const services = result.services as Record<string, { ports: string[] }>;
    expect(services.web.ports).toEqual(["80:80", "443:443"]);
  });

  it("adds new service from overlay", () => {
    const base = { services: { web: { image: "nginx" } } };
    const overlay = { services: { db: { image: "postgres" } } };
    const result = mergeComposeObjects(base, overlay);
    const services = result.services as Record<string, Record<string, unknown>>;
    expect(services.db).toEqual({ image: "postgres" });
    expect(services.web).toEqual({ image: "nginx" });
  });

  it("shallow-merges top-level networks object", () => {
    const base = { networks: { frontend: { driver: "bridge" } } };
    const overlay = { networks: { backend: { driver: "bridge" } } };
    const result = mergeComposeObjects(base, overlay);
    expect(result.networks).toEqual({
      frontend: { driver: "bridge" },
      backend: { driver: "bridge" },
    });
  });

  it("overlay value overrides base scalar top-level key", () => {
    const base = { version: "3.8" };
    const overlay = { version: "3.9" };
    const result = mergeComposeObjects(base, overlay);
    expect(result.version).toBe("3.9");
  });

  it("adds top-level key present only in overlay", () => {
    const base = { services: {} };
    const overlay = { volumes: { pgdata: null } };
    const result = mergeComposeObjects(base, overlay);
    expect(result.volumes).toEqual({ pgdata: null });
  });

  it("does not mutate base or overlay", () => {
    const base = { services: { web: { image: "nginx" } } };
    const overlay = { services: { web: { restart: "always" } } };
    mergeComposeObjects(base, overlay);
    expect((base.services as Record<string, Record<string, unknown>>).web.restart).toBeUndefined();
    expect((overlay.services as Record<string, Record<string, unknown>>).web.image).toBeUndefined();
  });

  it("handles missing services in base", () => {
    const base = { version: "3" };
    const overlay = { services: { web: { image: "nginx" } } };
    const result = mergeComposeObjects(base, overlay);
    const services = result.services as Record<string, Record<string, unknown>>;
    expect(services.web).toEqual({ image: "nginx" });
  });

  it("overlay scalar overrides a plain-object base value for non-services keys", () => {
    // base.networks is a plain object; overlay.networks is a scalar string.
    // isPlainObject(baseValue) && isPlainObject(overlayValue) is false → else branch.
    const base = { networks: { frontend: { driver: "bridge" } } };
    const overlay = { networks: "host" as unknown as Record<string, unknown> };
    const result = mergeComposeObjects(base, overlay);
    // overlay value wins regardless of base type.
    expect(result.networks).toBe("host");
  });

  it("overlay non-plain-object service entry overwrites base service (non-recursive path)", () => {
    // When a service entry in the overlay is NOT a plain object, it replaces
    // the base service rather than merging (line 164-166 in renderer.ts).
    const base = { services: { web: { image: "nginx", ports: ["80:80"] } } };
    const overlay = { services: { web: "disabled" as unknown as Record<string, unknown> } };
    const result = mergeComposeObjects(base, overlay);
    const services = result.services as Record<string, unknown>;
    // "web" is overwritten with the scalar "disabled", not merged.
    expect(services.web).toBe("disabled");
  });
});
