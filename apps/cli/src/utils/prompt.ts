/**
 * Zero-dependency interactive prompts using Node's built-in readline.
 * Used by `appbay init` for first-run configuration.
 */

import * as readline from "node:readline";

/** Ask a question and return the trimmed answer. Returns defaultValue if empty. */
export function ask(question: string, defaultValue = ""): Promise<string> {
  const hint = defaultValue ? ` [${defaultValue}]` : "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${question}${hint}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

/** Ask a question with hidden input (password). */
export function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    process.stdout.write(`  ${question}: `);

    // Hide input on TTY
    const isTTY = process.stdin.isTTY;
    if (isTTY) {
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    }

    rl.question("", (answer) => {
      rl.close();
      if (isTTY) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

/** Ask a yes/no question. Returns true for yes. */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await ask(`${question} (${hint})`, defaultYes ? "y" : "n");
  return answer.toLowerCase().startsWith("y");
}
