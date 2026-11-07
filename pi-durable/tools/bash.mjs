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
    timeout: { type: "string", default: "60" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("Usage: node tools/bash.mjs --user TELEGRAM_USER_ID [--write] [--timeout SECONDS] [-c 'command']\nConnects to the production DO via a temporary Wrangler remote dev session.\nRead-only by default. Requests time out after 60 seconds by default.\nRequires Cloudflare login; never deploy this debug Worker.");
    return;
  }
  const user = values.user ?? process.env.TELEGRAM_USER_ID;
  if (!/^[1-9][0-9]*$/.test(user ?? "") || !Number.isSafeInteger(Number(user))) throw new Error("Set --user to the production TELEGRAM_USER_ID (a positive safe integer)");
  if (values.command !== undefined && (!values.command.trim() || values.command.length > 32_000)) throw new Error("Command must contain 1–32,000 characters");
  const timeoutSeconds = Number(values.timeout);
  const timeoutMs = Math.ceil(timeoutSeconds * 1_000);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutMs > 2_147_483_647) throw new Error("--timeout must be a positive number of seconds, at most 2147483.647");

  const { unstable_dev, unstable_readConfig } = await import("wrangler");
  const production = unstable_readConfig({ config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)) });
  const binding = production.durable_objects.bindings.find(binding => binding.name === "AGENT");
  if (!production.name || !binding) throw new Error("The project must define a Worker name and AGENT Durable Object binding");
  const script = binding.script_name ?? production.name;
  const token = randomUUID();
  console.error(`Production: ${script} / ${user} (${values.write ? "READ-WRITE: file changes are immediate and not rolled back" : "read-only"}).`);
  console.error("Starting the Cloudflare remote debug session...");
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
  async function request(route, body, connecting = false) {
    const request = new AbortController();
    const signal = AbortSignal.any([controller.signal, request.signal]);
    const startedAt = Date.now();
    const deadline = setTimeout(() => request.abort(), timeoutMs);
    const progress = setInterval(() => {
      console.error(`Waiting for ${connecting ? "Cloudflare and the production filesystem" : "the remote command"} (${Math.floor((Date.now() - startedAt) / 1_000)}s elapsed; Ctrl+C to cancel)...`);
    }, 5_000);
    try {
      const response = await worker.fetch(route, {
        method: "POST",
        headers: { "content-type": "application/json", "x-debug-token": token },
        body: JSON.stringify({ ...body, env }),
        redirect: "error",
        signal,
      });
      const responseText = await response.text();
      signal.throwIfAborted();
      let result;
      try { result = JSON.parse(responseText); }
      catch {
        const detail = responseText.replaceAll(token, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 300);
        throw new Error(`Cloudflare remote preview returned a non-JSON response (HTTP ${response.status}): ${detail || "empty response"} (request was not retried)`);
      }
      if (!response.ok) {
        const error = new Error(`${result.error ?? `HTTP ${response.status}`} (request was not retried)`);
        error.code = result.code ?? (response.status === 403 ? "EROFS" : "EIO");
        throw error;
      }
      return result;
    } catch (error) {
      if (request.signal.aborted && !controller.signal.aborted) throw new Error(`Remote request timed out after ${timeoutSeconds}s (request was not retried).${values.write ? " Remote writes may have completed; inspect files before retrying." : " Check the Cloudflare preview connection or increase --timeout."}`);
      throw error;
    } finally {
      clearTimeout(deadline);
      clearInterval(progress);
    }
  }
  async function execute(command, connecting = false) {
    const result = await request("/bash", { command, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) }, connecting);
    env = result.env;
    // shortcut: just-bash 3.6.0 drops stdout byte metadata, revisit raw binary output when upstream preserves it.
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
    if (result.editor) {
      terminal?.close();
      terminal = undefined;
      const { runVim } = await import("./vim.mjs");
      process.exitCode = await runVim(result.editor, {
        signal: controller.signal,
        request: async (method, args) => (await request("/fs", { method, args })).result,
      });
      return true;
    }
    return false;
  }
  try {
    if (values.command !== undefined) return await execute(values.command);
    console.error("Connecting to the production filesystem...");
    await execute("pwd", true);
    console.error("Connected. just-bash: enter one complete command per line; exit, Ctrl+D or Ctrl+C to leave.");
    let reopen = true;
    while (reopen && !controller.signal.aborted) {
      reopen = false;
      terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
      terminal.on("SIGINT", interrupt);
      const prompt = () => {
        if (terminal.terminal) { terminal.setPrompt(`just-bash(${user}:${values.write ? "rw" : "ro"}) ${env.PWD}> `); terminal.prompt(); }
      };
      prompt();
      for await (const line of terminal) {
        if (line.trim() === "exit" || controller.signal.aborted) break;
        if (line.trim() && await execute(line)) { reopen = true; break; }
        prompt();
      }
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
