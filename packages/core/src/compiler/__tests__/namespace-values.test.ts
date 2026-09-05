/**
 * A namespace carries values (docs/steering/product.md), the default ingress host comes from
 * identity, and two apps at one host are a compile error naming both (S40; ledger rows 10, 21).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../compile.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "appbay-ns-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function app(name: string, manifest: string, compose = `services:\n  web:\n    image: nginx\n`): Promise<void> {
  const d = join(dir, "apps", name);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, "docker-compose.yml"), compose);
  await writeFile(join(d, "appbay.yaml"), manifest);
}
const opts = (extra: Record<string, unknown> = {}) => ({
  appsDir: join(dir, "apps"), rendersDir: join(dir, "renders"), stateDir: join(dir, "state"),
  namespacesDir: join(dir, "namespaces"), projectVars: { DOMAIN: "example.org" }, ...extra,
});

describe("namespace values", () => {
  it("resolve from etc/namespaces/<ns>.yaml for the app's namespace", async () => {
    await mkdir(join(dir, "namespaces"), { recursive: true });
    await writeFile(join(dir, "namespaces", "uom.sim.yaml"), "TIER: sim\nREPLICAS: 2\n");
    await app("litellm", "namespace: uom.sim\n", "services:\n  web:\n    image: nginx\n    environment:\n      - TIER=${{namespace.TIER}}\n      - N=${{namespace.REPLICAS}}\n");
    const r = await compile(opts());
    expect(r.errors).toEqual([]);
    expect(r.apps[0]!.rendered).toContain("TIER=sim");
    expect(r.apps[0]!.rendered).toContain("N=2");
  });

  it("an un-namespaced app reads default.yaml, and a missing file is an empty scope", async () => {
    await app("plain", "", "services:\n  web:\n    image: nginx\n    environment:\n      - X=${{namespace.X}}\n");
    const r = await compile(opts());
    expect(r.errors.map((e) => e.message).join("\n")).toContain('"X" in scope "namespace"');
  });

  it("the app scope knows NAME, NAMESPACE, STEM and HOST", async () => {
    await app("litellm", "namespace: uom.sim\n", "services:\n  web:\n    image: nginx\n    environment:\n      - A=${{app.NAME}}\n      - B=${{app.NAMESPACE}}\n      - C=${{app.STEM}}\n      - D=${{app.HOST}}\n");
    const r = await compile(opts());
    expect(r.errors).toEqual([]);
    const out = r.apps[0]!.rendered;
    expect(out).toContain("A=litellm");
    expect(out).toContain("B=uom.sim");
    expect(out).toContain("C=uom-sim.litellm");
    expect(out).toContain("D=uom-sim.litellm.example.org");
  });
});

describe("the default ingress host", () => {
  it("is <app>.<domain>, or <ns>.<app>.<domain> when namespaced, when host: is omitted", async () => {
    await app("a", "services:\n  web:\n    traits:\n      - type: ingress\n        port: 80\n");
    await app("b", "namespace: uom.sim\nservices:\n  web:\n    traits:\n      - type: ingress\n        port: 80\n");
    const r = await compile(opts());
    expect(r.errors).toEqual([]);
    const aux = (n: string) => r.apps.find((x) => x.appName === n)!.auxiliaryFiles.map((f) => f.content).join("\n");
    expect(aux("a")).toContain("a.example.org");
    expect(aux("b")).toContain("uom-sim.b.example.org");
  });

  it("two instances from one manifest get two hosts without either saying so", async () => {
    const m = (ns: string) => `namespace: ${ns}\nservices:\n  web:\n    traits:\n      - type: ingress\n        port: 80\n`;
    await app("litellm-sim", m("uom.sim"));
    await app("litellm-prod", m("uom.prod"));
    const r = await compile(opts());
    expect(r.errors).toEqual([]);
  });

  it("is a compile error, naming both apps, when two apps resolve one host", async () => {
    const m = "services:\n  web:\n    traits:\n      - type: ingress\n        host: chat.${{project.DOMAIN}}\n        port: 80\n";
    await app("lobechat", m);
    await app("open-webui", m);
    const r = await compile(opts());
    const msgs = r.errors.filter((e) => e.stage === "ingress").map((e) => `${e.appName}: ${e.message}`);
    expect(msgs).toHaveLength(2);
    expect(msgs.join("\n")).toContain("chat.example.org is routed by more than one app: lobechat, open-webui");
  });

  it("refuses an ingress with no host: and no domain", async () => {
    await app("a", "services:\n  web:\n    traits:\n      - type: ingress\n        port: 80\n");
    const r = await compile(opts({ projectVars: {} }));
    expect(r.errors.map((e) => e.message).join("\n")).toContain("no host: given and the install has no domain");
  });
});
