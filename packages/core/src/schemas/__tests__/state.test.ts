import { describe, it, expect } from "vitest";
import {
  GeneratedValueSchema,
  GeneratedValuesFileSchema,
  ActiveAppsSchema,
  DeployRecordSchema,
} from "../state.js";

// ---------------------------------------------------------------------------
// GeneratedValuesFileSchema
// ---------------------------------------------------------------------------

describe("GeneratedValuesFileSchema", () => {
  const sampleValues = {
    version: 1 as const,
    values: [
      {
        key: {
          project: "homelab",
          environment: "prod",
          service: "jellyfin",
          varName: "DB_PASS",
        },
        value: "r4nd0mP@ssw0rd!",
        generator: "password:16",
        createdAt: "2026-01-15T10:30:00Z",
      },
      {
        key: {
          project: "homelab",
          environment: "prod",
          service: "nextcloud",
          varName: "INSTANCE_ID",
        },
        value: "550e8400-e29b-41d4-a716-446655440000",
        generator: "uuid",
        createdAt: "2026-01-15T10:31:00Z",
      },
    ],
  };

  it("parses a generated values file with multiple entries", () => {
    const result = GeneratedValuesFileSchema.parse(sampleValues);

    expect(result.version).toBe(1);
    expect(result.values).toHaveLength(2);
    expect(result.values[0]!.key.varName).toBe("DB_PASS");
    expect(result.values[0]!.generator).toBe("password:16");
    expect(result.values[1]!.key.service).toBe("nextcloud");
    expect(result.values[1]!.generator).toBe("uuid");
  });

  it("round-trips through parse and back to plain object", () => {
    const parsed = GeneratedValuesFileSchema.parse(sampleValues);
    // Serialize to JSON and re-parse to verify round-trip fidelity
    const serialized = JSON.parse(JSON.stringify(parsed));
    const reparsed = GeneratedValuesFileSchema.parse(serialized);

    expect(reparsed).toEqual(parsed);
  });

  it("parses an empty values array", () => {
    const result = GeneratedValuesFileSchema.parse({
      version: 1,
      values: [],
    });

    expect(result.version).toBe(1);
    expect(result.values).toEqual([]);
  });

  it("rejects an invalid version number", () => {
    const result = GeneratedValuesFileSchema.safeParse({
      version: 2,
      values: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a value with an invalid datetime", () => {
    const result = GeneratedValueSchema.safeParse({
      key: {
        project: "test",
        environment: "dev",
        service: "app",
        varName: "SECRET",
      },
      value: "abc123",
      generator: "password:8",
      createdAt: "not-a-date",
    });

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ActiveAppsSchema
// ---------------------------------------------------------------------------

describe("ActiveAppsSchema", () => {
  it("parses an active apps file with mixed statuses", () => {
    const result = ActiveAppsSchema.parse({
      version: 1,
      apps: [
        {
          name: "traefik",
          project: "homelab",
          environment: "prod",
          status: "running",
          lastDeploy: "2026-05-01T08:00:00Z",
        },
        {
          name: "jellyfin",
          project: "homelab",
          environment: "prod",
          status: "stopped",
        },
        {
          name: "nextcloud",
          project: "homelab",
          environment: "prod",
          status: "error",
          lastDeploy: "2026-04-30T22:15:00Z",
        },
        {
          name: "ollama",
          project: "homelab",
          environment: "dev",
          status: "unknown",
        },
      ],
    });

    expect(result.version).toBe(1);
    expect(result.apps).toHaveLength(4);

    const statuses = result.apps.map((a) => a.status);
    expect(statuses).toEqual(["running", "stopped", "error", "unknown"]);

    // lastDeploy is optional
    expect(result.apps[0]!.lastDeploy).toBe("2026-05-01T08:00:00Z");
    expect(result.apps[1]!.lastDeploy).toBeUndefined();
  });

  it("rejects an invalid app status", () => {
    const result = ActiveAppsSchema.safeParse({
      version: 1,
      apps: [
        {
          name: "broken",
          project: "test",
          environment: "dev",
          status: "crashed",
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DeployRecordSchema
// ---------------------------------------------------------------------------

describe("DeployRecordSchema", () => {
  it("parses a successful deploy record", () => {
    const result = DeployRecordSchema.parse({
      id: "deploy-001",
      timestamp: "2026-05-02T14:30:00Z",
      apps: ["traefik", "jellyfin"],
      status: "success",
      planHash: "sha256:abc123def456",
    });

    expect(result.id).toBe("deploy-001");
    expect(result.apps).toEqual(["traefik", "jellyfin"]);
    expect(result.status).toBe("success");
    expect(result.planHash).toBe("sha256:abc123def456");
    expect(result.error).toBeUndefined();
  });

  it("parses a failed deploy record with error message", () => {
    const result = DeployRecordSchema.parse({
      id: "deploy-002",
      timestamp: "2026-05-02T15:00:00Z",
      apps: ["nextcloud"],
      status: "failed",
      error: "Container healthcheck failed after 30s timeout",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe(
      "Container healthcheck failed after 30s timeout",
    );
  });

  it("parses deploy records through all lifecycle statuses", () => {
    const validStatuses = [
      "pending",
      "running",
      "success",
      "failed",
      "cancelled",
    ] as const;

    for (const status of validStatuses) {
      const result = DeployRecordSchema.safeParse({
        id: `deploy-${status}`,
        timestamp: "2026-05-02T16:00:00Z",
        apps: ["app"],
        status,
      });

      expect(result.success, `Expected status '${status}' to be valid`).toBe(
        true,
      );
    }
  });

  it("rejects an invalid deploy status", () => {
    const result = DeployRecordSchema.safeParse({
      id: "deploy-bad",
      timestamp: "2026-05-02T16:00:00Z",
      apps: ["app"],
      status: "rollback",
    });

    expect(result.success).toBe(false);
  });
});
