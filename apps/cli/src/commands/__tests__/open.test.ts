/**
 * Unit tests for extractHostPort.
 *
 * Docker compose port mappings come in several formats:
 *
 *   "8080:80"               → hostPort = 8080  (2-part)
 *   "127.0.0.1:8080:80"    → hostPort = 8080  (3-part with IP)
 *   "8080:80/tcp"           → hostPort = 8080  (protocol suffix)
 *   "80"                    → null             (no host port)
 *   "abc:80"               → null             (non-numeric host port)
 *
 * The function strips the protocol suffix (/tcp, /udp) first,
 * then splits on ":" and returns the appropriate segment as a number.
 * Returns null for any format that doesn't yield a valid positive integer.
 */

import { describe, it, expect } from "vitest";
import { extractHostPort } from "../open.js";

// ---------------------------------------------------------------------------
// 2-part format: "hostPort:containerPort"
// ---------------------------------------------------------------------------

describe("extractHostPort — 2-part format", () => {
  it("returns hostPort from 'hostPort:containerPort'", () => {
    expect(extractHostPort("8080:80")).toBe(8080);
  });

  it("handles standard web port mapping", () => {
    expect(extractHostPort("443:443")).toBe(443);
  });

  it("handles high port mapping", () => {
    expect(extractHostPort("32768:5432")).toBe(32768);
  });

  it("returns null for non-numeric host port in 2-part", () => {
    expect(extractHostPort("abc:80")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3-part format: "host:hostPort:containerPort"
// ---------------------------------------------------------------------------

describe("extractHostPort — 3-part format", () => {
  it("returns hostPort (middle segment) for 3-part mapping", () => {
    expect(extractHostPort("127.0.0.1:8080:80")).toBe(8080);
  });

  it("works with 0.0.0.0 bind address", () => {
    expect(extractHostPort("0.0.0.0:5432:5432")).toBe(5432);
  });

  it("works with localhost bind address", () => {
    expect(extractHostPort("localhost:3000:3000")).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// Protocol suffix stripping (/tcp, /udp)
// ---------------------------------------------------------------------------

describe("extractHostPort — protocol suffix", () => {
  it("strips /tcp suffix before parsing", () => {
    expect(extractHostPort("8080:80/tcp")).toBe(8080);
  });

  it("strips /udp suffix before parsing", () => {
    expect(extractHostPort("514:514/udp")).toBe(514);
  });

  it("strips /tcp from 3-part format", () => {
    expect(extractHostPort("127.0.0.1:8080:80/tcp")).toBe(8080);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — null returns
// ---------------------------------------------------------------------------

describe("extractHostPort — null returns", () => {
  it("returns null for bare container port (single segment)", () => {
    // No ":" → parts.length === 1 → neither 2 nor 3 → null
    expect(extractHostPort("80")).toBeNull();
  });

  it("returns null for port 0 (falsy, treated as invalid)", () => {
    expect(extractHostPort("0:80")).toBeNull();
  });

  it("returns null for non-numeric host in 3-part", () => {
    expect(extractHostPort("host:notaport:80")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractHostPort("")).toBeNull();
  });
});
