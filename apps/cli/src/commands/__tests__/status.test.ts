/**
 * Unit tests for status command utilities.
 *
 * `extractServiceNames` is a pure function that extracts and sorts the
 * service names from a Docker Compose content object. Zero mocks needed.
 *
 * Coverage:
 *   - standard compose object with services → sorted string[]
 *   - services in non-alphabetical order → returned in alphabetical order
 *   - object without a "services" key → []
 *   - "services" is null → []
 *   - "services" is an array (invalid compose) → []
 *   - "services" is a string (invalid compose) → []
 *   - "services" is an empty object → []
 *   - single service → [name]
 *   - names with numbers sort correctly (lexicographic)
 */

import { describe, it, expect } from "vitest";
import { extractServiceNames } from "../status.js";

describe("extractServiceNames", () => {
  // ── Normal cases ──────────────────────────────────────────────────────────

  it("returns sorted service names from a standard compose object", () => {
    const compose = {
      services: {
        web: {},
        db: {},
        cache: {},
      },
    };
    expect(extractServiceNames(compose)).toEqual(["cache", "db", "web"]);
  });

  it("returns services in alphabetical order regardless of insertion order", () => {
    const compose = {
      services: {
        z_service: {},
        a_service: {},
        m_service: {},
      },
    };
    expect(extractServiceNames(compose)).toEqual([
      "a_service",
      "m_service",
      "z_service",
    ]);
  });

  it("returns a single service name in a single-element array", () => {
    const compose = { services: { web: {} } };
    expect(extractServiceNames(compose)).toEqual(["web"]);
  });

  it("handles services with numeric suffixes (lexicographic sort)", () => {
    const compose = {
      services: {
        worker2: {},
        worker10: {},
        worker1: {},
      },
    };
    // Lexicographic: "worker1" < "worker10" < "worker2"
    expect(extractServiceNames(compose)).toEqual([
      "worker1",
      "worker10",
      "worker2",
    ]);
  });

  // ── Missing or empty services ─────────────────────────────────────────────

  it("returns [] when there is no 'services' key", () => {
    expect(extractServiceNames({})).toEqual([]);
  });

  it("returns [] when 'services' is an empty object", () => {
    expect(extractServiceNames({ services: {} })).toEqual([]);
  });

  // ── Invalid services shapes (should not throw, just return []) ────────────

  it("returns [] when 'services' is null", () => {
    expect(extractServiceNames({ services: null })).toEqual([]);
  });

  it("returns [] when 'services' is undefined", () => {
    expect(extractServiceNames({ services: undefined })).toEqual([]);
  });

  it("returns [] when 'services' is an array (invalid compose)", () => {
    // Arrays are objects but Array.isArray guard prevents treating them as map
    expect(extractServiceNames({ services: ["web", "db"] })).toEqual([]);
  });

  it("returns [] when 'services' is a string (invalid compose)", () => {
    expect(
      extractServiceNames({ services: "not-an-object" }),
    ).toEqual([]);
  });

  it("returns [] when 'services' is a number (invalid compose)", () => {
    expect(extractServiceNames({ services: 42 })).toEqual([]);
  });

  // ── Extra top-level keys do not interfere ─────────────────────────────────

  it("ignores top-level keys other than 'services'", () => {
    const compose = {
      version: "3.8",
      networks: { default: {} },
      volumes: { data: {} },
      services: { api: {}, worker: {} },
    };
    expect(extractServiceNames(compose)).toEqual(["api", "worker"]);
  });
});
