/**
 * Ownership rules, enforced by grep (S37). Each rule names the files allowed to do a thing
 * today. A new file doing it fails the test; a listed file that stops doing it fails too,
 * so the list can only shrink deliberately. When a list is empty the rule is simply true.
 *
 * The layer rule these serve is in docs/steering/structure.md: only `runtime/` talks to the
 * container binary, one loader per file, one home resolver, identity owns every name.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");
const SRC = ["packages/core/src", "apps/cli/src"];

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "__tests__" && name !== "dist" && name !== "node_modules") walk(p); }
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
    }
  };
  for (const s of SRC) walk(join(ROOT, s));
  return out;
}

interface Rule {
  name: string;
  /** Source roots the rule scans; default: both packages. */
  scope?: string[];
  /** A file violates the rule when this matches its content. */
  pattern: RegExp;
  /** Files that own the behaviour — never violations. */
  owners: string[];
  /** Files that legitimately do this for a reason that is not the runtime (each with why). */
  exempt: Record<string, string>;
  /** Files still violating today, each with the S37 task that removes it. */
  allowed: Record<string, string>;
}

const RULES: Rule[] = [
  {
    name: "only runtime/ spawns a process (core)",
    scope: ["packages/core/src"],
    pattern: /\b(spawnSync|execFileSync|execSync|execFileAsync|spawn)\(/,
    owners: ["packages/core/src/runtime/"],
    exempt: {
      "packages/core/src/secrets/providers/sops.ts": "spawns the sops binary, not the container runtime",
      "packages/core/src/services/catalog-service.ts": "spawns git for a catalog source",
    },
    allowed: {
      "packages/core/src/compiler/builds.ts": "2.1/2.4",
      "packages/core/src/compiler/compile.ts": "2.4 (ollama probe)",
      "packages/core/src/secrets/resolve-for-deploy.ts": "2.1 (volume create)",
      "packages/core/src/services/deploy-service.ts": "2.2/2.3",
      "packages/core/src/services/edge-identity-service.ts": "2.4",
      "packages/core/src/services/edge-migration-service.ts": "2.4",
      "packages/core/src/shepherd/run-shepherd.ts": "2.1",
    },
  },
  {
    name: "Go-template parsing of runtime output lives in runtime/",
    pattern: /\{\{\.(State|Config|NetworkSettings|Names|Name|Id|ID|Ports|Labels|Image)\b/,
    owners: ["packages/core/src/runtime/"],
    exempt: {},
    allowed: {
      "apps/cli/src/commands/server.ts": "2.4",
      "apps/cli/src/commands/setup.ts": "2.4",
      "apps/cli/src/commands/size.ts": "2.4",
      "apps/cli/src/commands/stats.ts": "2.4",
      "packages/core/src/compiler/builds.ts": "2.4",
      "packages/core/src/compiler/compile.ts": "2.4",
      "packages/core/src/health/checks.ts": "2.4/2.5",
      "packages/core/src/services/edge-migration-service.ts": "2.4",
    },
  },
  {
    name: "the instance config has one loader",
    pattern: /readInstanceConfigText\(|\^(project|domain|home):/,
    owners: ["packages/core/src/schemas/instance.ts", "packages/core/src/runtime/container-runtime.ts"],
    exempt: {},
    allowed: {},
  },
  {
    name: "a YAML document is parsed through its schema, not cast",
    pattern: /parseYaml\([^)]*\)[^;\n]*as Record<string, unknown>/,
    owners: ["packages/core/src/schemas/"],
    exempt: {},
    allowed: {
      "packages/core/src/compiler/compile.ts": "2.7",
      "packages/core/src/services/catalog-service.ts": "2.7",
      "packages/core/src/services/config-service.ts": "2.7",
    },
  },
  {
    name: "APPBAY_HOME is resolved in one place",
    pattern: /process\.env\.APPBAY_HOME/,
    owners: ["packages/core/src/runtime/home.ts"],
    exempt: {},
    allowed: {
      "apps/cli/src/commands/init.ts": "2.8",
      "apps/cli/src/index.ts": "2.8",
      "apps/cli/src/utils/appbay-home.ts": "2.8",
      "packages/core/src/runtime/container-runtime.ts": "2.8",
      "packages/core/src/secrets/master-password.ts": "2.8",
      "packages/core/src/secrets/providers/keepass.ts": "2.8",
      "packages/core/src/secrets/providers/vault.ts": "2.8",
    },
  },
  {
    name: "the shared network's name comes from identity",
    pattern: /appbay_shared\b/,
    owners: ["packages/core/src/compiler/identity.ts", "packages/core/src/system-apps.ts", "packages/core/src/schemas/"],
    exempt: {},
    allowed: {
      "apps/cli/src/commands/init.ts": "2.9",
      "apps/cli/src/commands/mcp.ts": "2.9",
      "apps/cli/src/commands/models.ts": "2.9",
      "apps/cli/src/commands/server.ts": "2.9",
      "apps/cli/src/commands/setup.ts": "2.9",
      "apps/cli/src/commands/tunnel.ts": "2.9",
      "packages/core/src/compiler/compile.ts": "2.9",
      "packages/core/src/compiler/upstream-transform.ts": "2.9",
      "packages/core/src/health/checks.ts": "2.9",
      "packages/core/src/runtime/container-runtime.ts": "2.9",
      "packages/core/src/services/control-plane-edge.ts": "2.9",
      "packages/core/src/traits/definitions/ingress.ts": "2.9",
    },
  },
];

describe("ownership rules (docs/steering/structure.md)", () => {
  const files = sources();
  for (const rule of RULES) {
    it(rule.name, () => {
      const violators = new Set<string>();
      for (const abs of files) {
        const rel = relative(ROOT, abs);
        if (rule.scope && !rule.scope.some((r) => rel.startsWith(r))) continue;
        if (rule.owners.some((o) => rel.startsWith(o))) continue;
        if (rel in rule.exempt) continue;
        if (rule.pattern.test(readFileSync(abs, "utf-8"))) violators.add(rel);
      }
      const expected = new Set(Object.keys(rule.allowed));
      const unexpected = [...violators].filter((v) => !expected.has(v));
      const stale = [...expected].filter((e) => !violators.has(e));
      expect(unexpected.join(", "), "new violations — give the behaviour to its owner").toBe("");
      expect(stale.join(", "), "listed files no longer violate — remove them from the list").toBe("");
    });
  }
});
