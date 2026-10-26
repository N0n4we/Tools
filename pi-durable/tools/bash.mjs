#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({ options: {
    user: { type: "string" },
    write: { type: "boolean", default: false },
    command: { type: "string", short: "c" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("Usage: node tools/bash.mjs --user TELEGRAM_USER_ID [--write] [-c 'command']\nConnects to the production DO via a temporary Wrangler remote dev session.\nRead-only by default. Requires Cloudflare login; never deploy this debug Worker.");
    return;
  }
  const user = values.user ?? process.env.TELEGRAM_USER_ID;
  if (!/^[1-9][0-9]*$/.test(user ?? "") || !Number.isSafeInteger(Number(user))) throw new Error("Set --user to the production TELEGRAM_USER_ID (a positive safe integer)");
  if (values.command !== undefined && (!values.command.trim() || values.command.length > 32_000)) throw new Error("Command must contain 1–32,000 characters");

  const { unstable_dev, unstable_readConfig } = await import("wrangler");
  const production = unstable_readConfig({ config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)) });
  const binding = production.durable_objects.bindings.find(binding => binding.name === "AGENT");
  if (!production.name || !binding) throw new Error("The project must define a Worker name and AGENT Durable Object binding");
  const script = binding.script_name ?? production.name;
  const token = randomUUID();
  console.error(`Production: ${script} / ${user} (${values.write ? "READ-WRITE: file changes are immediate and not rolled back" : "read-only"}).`);
  const worker = await unstable_dev(fileURLToPath(new URL("bash.worker.ts", import.meta.url)), {
    config: fileURLToPath(new URL("wrangler.jsonc", import.meta.url)),
    accountId: production.account_id,
    local: false,
    ip: "127.0.0.1",
    port: 0,
    envFiles: [],
    logLevel: "error",
    durableObjects: [{ ...binding, script_name: script }],
    vars: { TELEGRAM_USER_ID: user, MEMORY_PREFIX: production.vars.MEMORY_PREFIX ?? "hermes/", DEBUG_TOKEN: token, DEBUG_WRITE: values.write },
    experimental: { disableDevRegistry: true, showInteractiveDevSession: false, watch: false },
  });
  const controller = new AbortController();
  let terminal;
  let env;
  const interrupt = () => { process.exitCode = 130; controller.abort(); terminal?.close(); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  async function execute(command) {
    const response = await worker.fetch("/bash", {
      method: "POST",
      headers: { "content-type": "application/json", "x-debug-token": token },
      body: JSON.stringify({ command, env }),
      redirect: "error",
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${result.error ?? `HTTP ${response.status}`} (request was not retried)`);
    env = result.env;
    // shortcut: just-bash 3.6.0 drops stdout byte metadata, revisit raw binary output when upstream preserves it.
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  }
  try {
    if (values.command !== undefined) return await execute(values.command);
    console.error("just-bash: enter one complete command per line; exit, Ctrl+D or Ctrl+C to leave.");
    await execute("pwd");
    terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
    terminal.on("SIGINT", interrupt);
    const prompt = () => {
      if (terminal.terminal) { terminal.setPrompt(`just-bash(${user}:${values.write ? "rw" : "ro"}) ${env.PWD}> `); terminal.prompt(); }
    };
    prompt();
    for await (const line of terminal) {
      if (line.trim() === "exit" || controller.signal.aborted) break;
      if (line.trim()) await execute(line);
      prompt();
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    terminal?.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await worker.stop();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
