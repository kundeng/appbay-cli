/**
 * Unit tests for url-utils.ts — extractHostPort.
 *
 * extractHostPort(portSpec):
 *   - "host:container" format          → returns host port string
 *   - "container-only" format          → returns the value unchanged
 *   - "ip:host:container" format       → returns first segment (ip — edge case)
 *   - "${VAR:-default}:container"      → returns the default value
 *   - "${VAR:-default}" standalone     → returns the default value
 *   - "${VAR}" without default         → returns raw expression (not expanded)
 *   - "127.0.0.1:8080:80"             → returns "127.0.0.1" (ip segment)
 *   - Common port numbers              → parsed correctly
 */

import { describe, it, expect } from "vitest";
import { extractHostPort } from "../url-utils.js";

describe("extractHostPort", () => {
  // ── Basic formats ────────────────────────────────────────────────────────

  it("extracts host port from 'host:container' mapping", () => {
    expect(extractHostPort("8080:80")).toBe("8080");
  });

  it("returns container port unchanged when no ':' separator (container-only)", () => {
    expect(extractHostPort("3000")).toBe("3000");
  });

  it("works with port 443", () => {
    expect(extractHostPort("443:443")).toBe("443");
  });

  it("handles '127.0.0.1:8080:80' (ip:host:container) — returns ip segment", () => {
    // split(":")[0] returns "127.0.0.1" — caller gets the IP, not the port
    expect(extractHostPort("127.0.0.1:8080:80")).toBe("127.0.0.1");
  });

  // ── Env-var with default value (${VAR:-default}) ─────────────────────────

  it("expands '${PORT:-3000}:80' correctly → '3000'", () => {
    expect(extractHostPort("${PORT:-3000}:80")).toBe("3000");
  });

  it("expands standalone '${PORT:-3000}' correctly → '3000'", () => {
    expect(extractHostPort("${PORT:-3000}")).toBe("3000");
  });

  it("expands '${WEB_PORT:-8080}:8080' → '8080'", () => {
    expect(extractHostPort("${WEB_PORT:-8080}:8080")).toBe("8080");
  });

  it("expands '${HTTPS_PORT:-443}:443' → '443'", () => {
    expect(extractHostPort("${HTTPS_PORT:-443}:443")).toBe("443");
  });

  it("expands multiple-digit default correctly", () => {
    expect(extractHostPort("${APP_PORT:-12345}:80")).toBe("12345");
  });

  // ── Env-var WITHOUT default (${VAR}) ──────────────────────────────────────

  it("leaves '${PORT}:80' without default unexpanded — returns raw '${PORT}'", () => {
    // No ":-" in the expression → regex finds no match → ${PORT} is left as-is
    // split(":")[0] then returns "${PORT" (before the colon in ":80")
    expect(extractHostPort("${PORT}:80")).toBe("${PORT}");
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("handles empty string without throwing", () => {
    expect(extractHostPort("")).toBe("");
  });

  it("works with a plain port 80", () => {
    expect(extractHostPort("80:80")).toBe("80");
  });

  it("handles high-numbered port in mapping", () => {
    expect(extractHostPort("65535:65535")).toBe("65535");
  });
});
