/**
 * The single `${{project.KEY}}` store — RFC-001 §4, decision 1.2b.
 *
 * The cases that matter are the ones the consolidation settles, not the happy path: the two
 * readers disagreed about WHICH keys are variables, and §2.1 put an absolute filesystem path
 * in the file the wide one was reading.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadProjectVars, resolveScopedVars } from "../instance-vars.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "appbay-instance-vars-"));
});

async function writeSystemConfig(body: string): Promise<void> {
  await mkdir(join(home, "etc"), { recursive: true });
  await writeFile(join(home, "etc", "system.yaml"), body);
}

describe("which keys become variables", () => {
  it("exposes domain as DOMAIN", async () => {
    await writeSystemConfig("domain: example.org\n");
    expect(await loadProjectVars(home)).toEqual({ DOMAIN: "example.org" });
  });

  it("🚨 does NOT expose home — an absolute path is not an operator variable", async () => {
    // The regression §2.1 created. `catalog-service.ts` uppercased every top-level string
    // key, so once `init` started writing `home:` into this file, a catalog manifest's
    // `${{project.HOME}}` interpolated the installation's absolute path into `.env.local`.
    await writeSystemConfig(`home: ${home}\ndomain: example.org\n`);
    const vars = await loadProjectVars(home);
    expect(vars).not.toHaveProperty("HOME");
    expect(vars).toEqual({ DOMAIN: "example.org" });
  });

  it("does not expose the other installation settings either", async () => {
    // These resolved on the catalog-install path and failed to compile a moment later.
    // Measured zero live uses of any of them, so the narrow documented behaviour wins.
    await writeSystemConfig(
      "domain: example.org\nproject: myinstall\ncontainer_runtime: podman\n",
    );
    expect(Object.keys(await loadProjectVars(home))).toEqual(["DOMAIN"]);
  });
});

describe("where the file is", () => {
  it("reads the legacy project.yaml when etc/system.yaml is absent (§2.1 fallback)", async () => {
    await writeFile(join(home, "project.yaml"), "domain: legacy.example.org\n");
    expect(await loadProjectVars(home)).toEqual({ DOMAIN: "legacy.example.org" });
  });

  it("prefers etc/system.yaml over the legacy file", async () => {
    await writeFile(join(home, "project.yaml"), "domain: legacy.example.org\n");
    await writeSystemConfig("domain: new.example.org\n");
    expect(await loadProjectVars(home)).toEqual({ DOMAIN: "new.example.org" });
  });

  it("returns an empty store rather than throwing when there is no config at all", async () => {
    expect(await loadProjectVars(home)).toEqual({});
  });

  it("ignores a blank domain rather than binding DOMAIN to an empty string", async () => {
    // An empty DOMAIN would resolve rather than error, producing a hostname like
    // `litellm.` that fails much later and much less legibly.
    await writeSystemConfig("domain:\n");
    expect(await loadProjectVars(home)).toEqual({});
  });
});

describe("resolveScopedVars — the .env.local escape hatch", () => {
  it("substitutes a known key", () => {
    expect(resolveScopedVars("https://app.${{project.DOMAIN}}", { DOMAIN: "example.org" }))
      .toBe("https://app.example.org");
  });

  it("degrades an UNKNOWN key to a Compose variable instead of erroring", () => {
    // Deliberately different from the compiler's ScopeResolver, which records an error and
    // leaves the literal. Here the value is bound for `.env.local`, so `${TIER}` remains
    // meaningful — the operator can still supply it from the environment.
    expect(resolveScopedVars("${{project.TIER}}-litellm", {})).toBe("${TIER}-litellm");
  });

  it("leaves a non-project scope completely alone", () => {
    // `${{environment.KEY}}` and `${{service.KEY}}` resolve against empty maps in the
    // compiler; this path must not invent a second meaning for them.
    expect(resolveScopedVars("${{environment.TIER}}", { TIER: "sim" }))
      .toBe("${{environment.TIER}}");
  });

  it("leaves single-brace Compose references untouched", () => {
    expect(resolveScopedVars("${DOMAIN}", { DOMAIN: "example.org" })).toBe("${DOMAIN}");
  });
});
