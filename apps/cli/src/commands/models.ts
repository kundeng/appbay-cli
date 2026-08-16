import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { pad } from "../utils/formatting.js";

interface OllamaModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  modified_at: string;
  details: {
    format: string;
    family: string;
    parameter_size: string;
    quantization_level: string;
  };
}

function findOllamaContainer(): string | null {
  const result = spawnSync(
    "docker",
    ["ps", "--format", "{{.Names}}", "--filter", "name=ollama"],
    { encoding: "utf-8", timeout: 5_000 },
  );
  if (result.status !== 0) return null;
  const names = (result.stdout as string).trim().split("\n").filter(Boolean);
  return names.find((n) => n.includes("ollama")) ?? null;
}

function getOllamaUrl(): string {
  const envUrl = process.env.OLLAMA_HOST ?? process.env.APPBAY_OLLAMA_URL;
  if (envUrl) return envUrl.replace(/\/$/, "");

  const container = findOllamaContainer();
  if (!container) return "http://localhost:11434";

  // Try host port mapping first
  const port = spawnSync(
    "docker",
    ["port", container, "11434"],
    { encoding: "utf-8", timeout: 5_000 },
  );
  if (port.status === 0 && port.stdout) {
    const match = (port.stdout as string).trim().match(/:(\d+)/);
    if (match) return `http://localhost:${match[1]}`;
  }

  // Fall back to container IP on the appbay_shared network
  const ip = spawnSync(
    "docker",
    ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", container],
    { encoding: "utf-8", timeout: 5_000 },
  );
  if (ip.status === 0 && ip.stdout) {
    const addr = (ip.stdout as string).trim().split(" ").filter(Boolean)[0];
    if (addr) return `http://${addr}:11434`;
  }

  return "http://localhost:11434";
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days > 30) return `${Math.floor(days / 30)} months ago`;
  if (days > 0) return `${days} days ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours > 0) return `${hours} hours ago`;
  return "just now";
}

async function listModels(options: { json?: boolean }): Promise<void> {
  const url = getOllamaUrl();

  let resp: Response;
  try {
    resp = await fetch(`${url}/api/tags`);
  } catch {
    console.error(`Cannot reach Ollama at ${url}. Is it running?`);
    console.error(`  Try: appbay up ollama`);
    process.exit(1);
  }

  if (!resp.ok) {
    console.error(`Ollama API error: ${resp.status} ${resp.statusText}`);
    process.exit(1);
  }

  const data = (await resp.json()) as { models: OllamaModel[] };
  const models = data.models ?? [];

  if (models.length === 0) {
    console.log("No models found. Pull one with: appbay pull <model>");
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(models, null, 2));
    return;
  }

  const nameW = Math.max(5, ...models.map((m) => m.name.length)) + 2;
  const sizeW = 10;
  const paramW = 12;
  const quantW = 8;
  const modifiedW = 16;

  console.log(
    `${pad("NAME", nameW)}${pad("SIZE", sizeW)}${pad("PARAMS", paramW)}${pad("QUANT", quantW)}${pad("MODIFIED", modifiedW)}`,
  );

  for (const m of models) {
    console.log(
      `${pad(m.name, nameW)}${pad(formatSize(m.size), sizeW)}${pad(m.details?.parameter_size ?? "-", paramW)}${pad(m.details?.quantization_level ?? "-", quantW)}${pad(timeAgo(m.modified_at), modifiedW)}`,
    );
  }

  const totalSize = models.reduce((sum, m) => sum + m.size, 0);
  console.log(`\n${models.length} model(s), ${formatSize(totalSize)} total`);
}

async function removeModel(name: string): Promise<void> {
  const url = getOllamaUrl();

  let resp: Response;
  try {
    resp = await fetch(`${url}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch {
    console.error(`Cannot reach Ollama at ${url}. Is it running?`);
    process.exit(1);
  }

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`Failed to remove "${name}": ${body}`);
    process.exit(1);
  }

  console.log(`Removed: ${name}`);
}

export const modelsCommand = new Command("models")
  .description("Manage AI models (Ollama)")
  .addCommand(
    new Command("ls")
      .description("List downloaded models")
      .option("--json", "output as JSON")
      .action(listModels),
  )
  .addCommand(
    new Command("rm")
      .description("Remove a model")
      .argument("<model>", "model name (e.g., llama3:latest)")
      .action(removeModel),
  );

modelsCommand.action(() => {
  listModels({ json: false });
});
