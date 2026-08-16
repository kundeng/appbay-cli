import { describe, expect, it } from "vitest";
import { SecretStore } from "../store.js";
import { resolveSecretsForDeploy } from "../resolve-for-deploy.js";

function missingVaultStore(): SecretStore {
  const store = new SecretStore();
  store.registerProvider({
    scheme: "vault",
    resolve: async () => { throw new Error("secret not found"); },
    check: async (uri: string) => ({ uri, ok: false, error: "secret not found" }),
  });
  return store;
}

describe("resolveSecretsForDeploy", () => {
  it("omits missing optional credentials without inventing values", async () => {
    const result = await resolveSecretsForDeploy([{
      key: "CLOUDFLARE_API_TOKEN",
      uri: "vault://caddy/CLOUDFLARE_API_TOKEN",
      app: "caddy",
      optional: true,
    }], missingVaultStore());

    expect(result).toEqual({ env: {}, errors: [] });
  });

  it("reports a missing required credential", async () => {
    const result = await resolveSecretsForDeploy([{
      key: "EDGE_TOKEN_SECRET",
      uri: "vault://caddy/EDGE_TOKEN_SECRET",
      app: "caddy",
    }], missingVaultStore());

    expect(result.env).toEqual({});
    expect(result.errors[0]?.ref.key).toBe("EDGE_TOKEN_SECRET");
  });
});
