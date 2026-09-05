/**
 * `etc/namespaces/<namespace>.yaml`: the values one deployment of an app resolves
 * `${{namespace.KEY}}` from. Flat `KEY: value`. The per-host layer beneath it is
 * `${{project.KEY}}` from `etc/system.yaml` (docs/steering/product.md, decided definitions).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const NAMESPACES_DIR_REL = "etc/namespaces";

const NamespaceValuesSchema = z.record(z.union([z.string(), z.number(), z.boolean()]));

/** The values for a namespace, as strings; `{}` when the file is absent. A present file that does not parse throws. */
export function loadNamespaceValues(namespacesDir: string, namespace: string): Record<string, string> {
  const path = join(namespacesDir, `${namespace}.yaml`);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed = NamespaceValuesSchema.parse(parseYaml(text) ?? {});
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
}
