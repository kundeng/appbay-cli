import { Command } from "commander";
import { runningAppContainer } from "../utils/docker.js";
import { containerEndpoint } from "@appbay/core";
import { resolveAppbayHome } from "../utils/appbay-home.js";
import { pad, formatBytes } from "../utils/formatting.js";

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

async function getOllamaUrl(): Promise<string> {
  const envUrl = process.env.OLLAMA_HOST ?? process.env.APPBAY_OLLAMA_URL;
  // Ollama's own convention for OLLAMA_HOST is `host:port`; fetch needs a scheme.
  if (envUrl) return (/^https?:\/\//.test(envUrl) ? envUrl : `http://${envUrl}`).replace(/\/$/, "");

  const found = await runningAppContainer("ollama");
  const container = found.kind === "ok" && found.value?.running ? found.value.name : null;
  if (!container) return "http://localhost:11434";

  const where = await containerEndpoint(container, 11434, resolveAppbayHome());
  if (where.kind === "ok" && where.value) return `http://${where.value}`;
  return "http://localhost:11434";
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
  const url = await getOllamaUrl();

  let resp: Response;
  try {
    resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(30_000) });
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
      `${pad(m.name, nameW)}${pad(formatBytes(m.size), sizeW)}${pad(m.details?.parameter_size ?? "-", paramW)}${pad(m.details?.quantization_level ?? "-", quantW)}${pad(timeAgo(m.modified_at), modifiedW)}`,
    );
  }

  const totalSize = models.reduce((sum, m) => sum + m.size, 0);
  console.log(`\n${models.length} model(s), ${formatBytes(totalSize)} total`);
}

async function removeModel(name: string): Promise<void> {
  const url = await getOllamaUrl();

  let resp: Response;
  try {
    resp = await fetch(`${url}/api/delete`, {
      signal: AbortSignal.timeout(30_000),
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

modelsCommand.action(() => listModels({ json: false }));
