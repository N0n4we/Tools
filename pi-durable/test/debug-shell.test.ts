import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { MAX_FILE_BYTES } from "../src/memory/store.js";

const token = "fixture-debug-token";
let mf: Miniflare;
let directory: string;

async function run(command: string, write = false, env?: Record<string, string>, terminal = false) {
  const worker = await mf.getWorker(write ? "read-write" : "read-only");
  const response = await worker.fetch("https://debug.invalid/bash", {
    method: "POST", headers: { "content-type": "application/json", "x-debug-token": token },
    body: JSON.stringify({ command, env, terminal }),
  });
  expect(response.status).toBe(200);
  return await response.json() as { stdout: string; stderr: string; exitCode: number; env: Record<string, string>; editor?: { args: string[]; cwd: string; readOnly: boolean } };
}

async function fileRequest(method: string, args: unknown[], write = false) {
  const worker = await mf.getWorker(write ? "read-write" : "read-only");
  return worker.fetch("https://debug.invalid/fs", {
    method: "POST", headers: { "content-type": "application/json", "x-debug-token": token }, body: JSON.stringify({ method, args }),
  });
}

async function edit(command: string, keys: string, write = false, rawInput = false) {
  const result = await run(command, write, undefined, true);
  expect(result.editor, result.stderr).toBeDefined();
  const { runVim } = await import("../tools/vim.mjs");
  let display = "";
  const writes: unknown[][] = [];
  const input = rawInput ? Object.assign(new PassThrough(), { isRaw: false, setRawMode(raw: boolean) { this.isRaw = raw; return this; } }) : null;
  const status = await runVim(result.editor!, {
    input, output: { columns: 80, rows: 24, write(value: string) { display += value; } }, signal: AbortSignal.timeout(10_000),
    async request(method: string, args: unknown[]) {
      if (method === "write") writes.push(args);
      const response = await fileRequest(method, args, write);
      const body = await response.json() as { result?: unknown; error?: string; code?: string };
      if (!response.ok) throw Object.assign(new Error(body.error), { code: body.code ?? (response.status === 403 ? "EROFS" : "EIO") });
      return body.result;
    },
    onReady(vim: { type(keys: string): void }) { if (input) input.write(keys); else vim.type(keys); },
  });
  return { status, display: display.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""), writes };
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-debug-shell-"));
  const options = { bundle: true, format: "esm" as const, platform: "browser" as const, target: "es2022", conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"], logLevel: "silent" as const };
  await build({ ...options, entryPoints: ["tools/bash.worker.ts"], outfile: path.join(directory, "debug.js") });
  await build({ ...options, stdin: { contents: `export { AgentBackend } from ${JSON.stringify(path.resolve("src/agent.ts"))}; export default { fetch() { return new Response(null, { status: 404 }); } };`, resolveDir: process.cwd() }, outfile: path.join(directory, "production.js") });
  const runtime = { modulesRoot: directory, compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"], outboundService: async () => { throw new Error("Network is forbidden in debug shell tests"); } };
  mf = new Miniflare({ workers: [
    ...[false, true].map(write => ({
      ...runtime, name: write ? "read-write" : "read-only", modules: [{ type: "ESModule" as const, path: path.join(directory, "debug.js") }],
      durableObjects: { AGENT: { className: "AgentBackend", scriptName: "production" } },
      bindings: { TELEGRAM_USER_ID: "123", MEMORY_PREFIX: "hermes/", DEBUG_TOKEN: token, DEBUG_WRITE: write, OPENROUTER_API_KEY: "fixture-deployment-secret" },
    })),
    {
      ...runtime, name: "production", modules: [{ type: "ESModule", path: path.join(directory, "production.js") }],
      durableObjects: { AGENT: { className: "AgentBackend", useSQLite: true } },
      bindings: { TELEGRAM_USER_ID: "123", MEMORY_PREFIX: "hermes/" },
    },
  ] });
  await mf.ready;
  expect((await run("printf seed > source.txt; mkdir -p skills/demo; printf nested > skills/demo/SKILL.md", true)).exitCode).toBe(0);
}, 30_000);

afterAll(async () => { await mf?.dispose(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

describe.sequential("debug Worker against a separate real SQLite Agent DO", () => {
  it("requires the session token and only accepts POST /bash", async () => {
    const worker = await mf.getWorker("read-only");
    for (const [route, method, secret, status] of [["/bash", "GET", token, 404], ["/other", "POST", token, 404], ["/bash", "POST", "wrong", 401], ["/bash", "POST", "", 401], ["/fs", "GET", token, 404], ["/fs", "POST", "wrong", 401]] as const) {
      const response = await worker.fetch(`https://debug.invalid${route}`, { method, headers: { "x-debug-token": secret } });
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain(token);
    }
  });

  it("validates commands, shell state and request size before accessing files", async () => {
    const worker = await mf.getWorker("read-only");
    for (const [body, status] of [[{ command: " " }, 400], [{ command: "x".repeat(32_001) }, 400], [{ command: "pwd", env: [] }, 400], [{ command: "pwd", env: { BAD: 1 } }, 400], [{ command: "pwd", env: { PWD: "relative" } }, 400], [{ command: "pwd", env: { LARGE: "x".repeat(65_536) } }, 413]] as const) {
      const response = await worker.fetch("https://debug.invalid/bash", { method: "POST", headers: { "content-type": "application/json", "x-debug-token": token }, body: JSON.stringify(body) });
      expect(response.status).toBe(status);
    }
  });

  it("reads production files through RPC, supports pipes, and restores cwd and variables", async () => {
    expect(await run("pwd; cat source.txt | tr a-z A-Z")).toMatchObject({ stdout: "/hermes/123\nSEED", exitCode: 0 });
    const changed = await run("cd skills/demo; VALUE=remembered");
    expect(changed.env.PWD).toBe("/hermes/123/skills/demo");
    expect(await run('pwd; printf "$VALUE:"; cat SKILL.md', false, changed.env)).toMatchObject({ stdout: "/hermes/123/skills/demo\nremembered:nested", exitCode: 0 });
    expect(await run("find skills -type f")).toMatchObject({ stdout: "skills/demo/SKILL.md\n", exitCode: 0 });
  });

  it.each([
    "printf overwritten > source.txt", "printf appended >> source.txt", "mkdir forbidden", "rm source.txt",
    "mv source.txt moved.txt", "cp source.txt copied.txt", "chmod 777 source.txt", "touch source.txt",
    "ln -s source.txt symbolic.txt", "ln source.txt hard.txt",
  ])("blocks filesystem mutations without --write: %s", async command => {
    const before = await run("find . | sort; cat source.txt; stat -c '%a %Y' source.txt");
    const worker = await mf.getWorker("read-only");
    const response = await worker.fetch("https://debug.invalid/bash", { method: "POST", headers: { "content-type": "application/json", "x-debug-token": token }, body: JSON.stringify({ command }) });
    const result = await response.json() as { error?: string; exitCode?: number; stderr?: string };
    expect([200, 403]).toContain(response.status);
    if (response.status === 403) expect(result.error).toContain("read-only debug session");
    else { expect(result.exitCode).not.toBe(0); expect(result.stderr).not.toBe(""); }
    expect((await run("find . | sort; cat source.txt; stat -c '%a %Y' source.txt")).stdout).toBe(before.stdout);
  });

  it("shares writes across sessions, preserves binary bytes and keeps production quotas", async () => {
    expect((await run("printf AP8= | base64 -d > bytes.bin; cp bytes.bin copy.bin; mv copy.bin moved.bin", true)).exitCode).toBe(0);
    expect((await run("base64 moved.bin")).stdout.trim()).toBe("AP8=");
    const binary = await run("cat bytes.bin");
    expect(binary.stdout).toBe("\x00\xff");
    expect((await run("rm moved.bin", true)).exitCode).toBe(0);
    const worker = await mf.getWorker("read-write");
    const oversized = await worker.fetch("https://debug.invalid/bash", { method: "POST", headers: { "content-type": "application/json", "x-debug-token": token }, body: JSON.stringify({ command: `printf '%0*d' ${MAX_FILE_BYTES + 1} 0 > oversized.txt` }) });
    expect(oversized.status).toBe(500);
    expect((await run("test ! -s oversized.txt")).exitCode).toBe(0);
  });

  it("does not inject credentials or enable external network commands", async () => {
    const result = await run("env; date '+%z'");
    expect(result.stdout).toContain("TZ=Asia/Shanghai");
    expect(result.stdout).toContain("+0800");
    expect(result.stdout).not.toMatch(/fixture-|DEBUG_TOKEN|OPENROUTER_API_KEY|TELEGRAM_USER_ID/);
    expect((await run("curl https://example.com")).exitCode).toBe(127);
  });

  it("registers vim/vi through defineCommand and resolves shell arguments in the virtual cwd", async () => {
    expect(await run("command -v vim; vi --version")).toMatchObject({ stdout: "/usr/bin/vim\nVIM - Vi IMproved 8.2.0055 (vim-wasm 0.0.13)\n", exitCode: 0 });
    expect(await run('vim "skills/demo/SKILL.md"', true, undefined, true)).toMatchObject({ editor: { args: ["skills/demo/SKILL.md"], cwd: "/hermes/123", readOnly: false } });
    const state = (await run('cd skills/demo; FILE="SKILL.md"')).env;
    expect(await run('vi "$FILE"', false, state, true)).toMatchObject({ editor: { args: ["SKILL.md"], cwd: "/hermes/123/skills/demo", readOnly: true } });
    for (const command of ["vim source.txt", "vim source.txt | cat", "vim source.txt > unused.txt"]) {
      const result = await run(command, true);
      if (!command.includes("|")) expect(result.exitCode).not.toBe(0);
      expect(result.editor).toBeUndefined();
      expect(result.stderr).toContain("interactive debug terminal");
    }
    expect((await run("vim --help")).stdout).toContain(":w saves production files");
  });

  it("guards the editor RPC, validates bytes and keeps file quotas", async () => {
    for (const [method, args] of [["write", ["/hermes/123/source.txt", ""]], ["mkdir", ["/hermes/123/editor-forbidden"]], ["unlink", ["/hermes/123/source.txt"]], ["rename", ["/hermes/123/source.txt", "/hermes/123/editor-moved.txt"]], ["chmod", ["/hermes/123/source.txt", 0o777]]] as const) {
      const response = await fileRequest(method, [...args]);
      expect(response.status).toBe(403);
      expect((await response.json() as any).error).toContain("read-only debug session");
    }
    for (const [method, args] of [["constructor", []], ["read", ["relative"]], ["write", ["/hermes/123/source.txt", "invalid!"]], ["chmod", ["/hermes/123/source.txt", -1]]] as const) {
      expect((await fileRequest(method, [...args], true)).status).toBe(400);
    }
    expect((await fileRequest("write", ["/hermes/123/editor-large.txt", Buffer.alloc(MAX_FILE_BYTES).toString("base64")], true)).status).toBe(200);
    expect((await fileRequest("write", ["/hermes/123/editor-large.txt", Buffer.alloc(MAX_FILE_BYTES + 1).toString("base64")], true)).status).toBe(413);
    expect((await run("wc -c < editor-large.txt")).stdout.trim()).toBe(String(MAX_FILE_BYTES));
    expect((await fileRequest("read", ["/hermes/123/missing-editor.txt"])).status).toBe(404);
    expect((await run("cat source.txt")).stdout).toBe("seed");
  });

  it("runs real WASM Vim, persists :w immediately and discards subsequent unsaved edits with :q!", async () => {
    await run("printf first > vim-save.txt", true);
    const result = await edit("vim vim-save.txt", "ggIedited \x1b:w\rA unsaved\x1b:q!\r", true);
    expect(result.status).toBe(0);
    expect(result.writes).toHaveLength(1);
    expect(result.display).toContain("written");
    expect((await run("cat vim-save.txt")).stdout).toBe("edited first\n");
  });

  it("handles raw terminal input when Escape and :wq arrive in one read", async () => {
    await run("printf first > vim-raw.txt", true);
    expect((await edit("vim vim-raw.txt", "ggIterminal \x1b:wq\r", true, true)).status).toBe(0);
    expect((await run("cat vim-raw.txt")).stdout).toBe("terminal first\n");
  });

  it("opens additional virtual files and saves a new file from inside WASM Vim", async () => {
    const result = await edit("vim", "i新文件\x1b:w vim-new.txt\r:e skills/demo/SKILL.md\rggIupdated \x1b:wq\r", true);
    expect(result.status).toBe(0);
    expect((await run("cat vim-new.txt; cat skills/demo/SKILL.md")).stdout).toBe("新文件\nupdated nested\n");
    await run("printf nested > skills/demo/SKILL.md", true);
  });

  it("keeps forced writes read-only and preserves the original file after an oversized Vim save", async () => {
    const readOnly = await edit("vim source.txt", "ggIforbidden \x1b:w!\r\x1b:q!\r");
    expect(readOnly.status).toBe(0);
    expect(readOnly.writes).toHaveLength(0);
    const oversized = await edit("vim source.txt", `:call setline(1, repeat('x', ${MAX_FILE_BYTES + 1}))\r:w\r\x1b:q!\r`, true);
    expect(oversized.status).toBe(0);
    expect(oversized.writes).toHaveLength(0);
    expect((await run("cat source.txt")).stdout).toBe("seed");
  });

  it("preserves UTF-8 BOM and CRLF bytes through the actual WASM editor", async () => {
    const bytes = Buffer.from("\uFEFF你好\r\n");
    expect((await fileRequest("write", ["/hermes/123/vim-unicode.txt", bytes.toString("base64")], true)).status).toBe(200);
    expect((await edit("vim vim-unicode.txt", "A 世界 é ě 🙂\x1b:wq\r", true)).status).toBe(0);
    const response = await fileRequest("read", ["/hermes/123/vim-unicode.txt"]);
    expect((await response.json() as any).result).toBe(Buffer.from("\uFEFF你好 世界 é ě 🙂\r\n").toString("base64"));
  });

  it("edits symlinks and virtual files below /tmp instead of the local filesystem", async () => {
    await run("mkdir -p /tmp; printf original > /tmp/vim-remote.txt; ln -s /tmp/vim-remote.txt vim-link.txt", true);
    expect((await edit("vim vim-link.txt", "ggIlinked \x1b:wq\r", true)).status).toBe(0);
    expect((await run("cat /tmp/vim-remote.txt; readlink vim-link.txt")).stdout).toBe("linked original\n/tmp/vim-remote.txt\n");
  });

  it("terminates the WASM worker on cancellation and restores the terminal screen", async () => {
    const { runVim } = await import("../tools/vim.mjs");
    const controller = new AbortController();
    let output = "";
    await expect(runVim({ args: [], cwd: "/hermes/123", readOnly: true }, {
      input: null, output: { columns: 80, rows: 24, write(value: string) { output += value; } }, signal: controller.signal,
      async request(method: string, args: unknown[]) {
        const response = await fileRequest(method, args);
        const body = await response.json() as { result?: unknown; error?: string; code?: string };
        if (!response.ok) throw Object.assign(new Error(body.error), { code: body.code });
        return body.result;
      },
      onReady() { controller.abort(new Error("fixture cancellation")); },
    })).rejects.toThrow("fixture cancellation");
    expect(output).toContain("\x1b[?1049h");
    expect(output.endsWith("\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l")).toBe(true);
  });
});

const dataURL = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;

function cli(args: string[], input?: string, scenario = "") {
  const mockWrangler = `
    import assert from "node:assert/strict";
    import { Bash } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/just-bash/dist/bundle/browser.js")).href)};
    export function unstable_readConfig({config}) {
      assert.equal(config, ${JSON.stringify(path.resolve("wrangler.jsonc"))});
      return {name: "fixture-production", account_id: "fixture-account", vars: {MEMORY_PREFIX: "custom/"}, durable_objects: {bindings: [{name: "AGENT", class_name: "AgentBackend"}]}};
    }
    export async function unstable_dev(script, options) {
      assert.ok(script.endsWith("/tools/bash.worker.ts"));
      assert.equal(options.local, false);
      assert.equal(options.ip, "127.0.0.1");
      assert.equal(options.accountId, "fixture-account");
      assert.deepEqual(options.durableObjects, [{name:"AGENT", class_name:"AgentBackend", script_name:"fixture-production"}]);
      assert.equal(options.vars.DEBUG_WRITE, process.argv.includes("--write"));
      const fs = new Bash({files: {"/custom/123/skills/file.txt": "fixture"}}).fs;
      let calls = 0;
      return {
        async fetch(route, request) {
          calls++;
          assert.equal(route, "/bash");
          assert.equal(request.headers["x-debug-token"], options.vars.DEBUG_TOKEN);
          const {command, env} = JSON.parse(request.body);
          if (command === "lost") throw new Error("simulated lost response");
          if (${JSON.stringify(scenario)} === "delay" && calls === 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
            process.stderr.write("fixture initial response ready\\n");
          }
          if (${JSON.stringify(scenario)} === "interrupt") setTimeout(() => process.kill(process.pid, "SIGINT"), 50);
          if (["pending", "interrupt"].includes(${JSON.stringify(scenario)})) await new Promise((resolve, reject) => {
            request.signal.throwIfAborted();
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {once: true});
          });
          if (${JSON.stringify(scenario)} === "network-error") return new Response("Error: Network connection lost. " + options.vars.DEBUG_TOKEN, {status: 502});
          if (${JSON.stringify(scenario)} === "pending-body") return {
            ok: true, status: 200,
            text: () => new Promise((resolve, reject) => {
              request.signal.throwIfAborted();
              request.signal.addEventListener("abort", () => reject(request.signal.reason), {once: true});
            }),
          };
          const bash = new Bash({fs, cwd: env?.PWD ?? "/custom/123", env});
          return Response.json(await bash.exec(command, {rawScript: true}));
        },
        async stop() { process.stderr.write("fixture stopped; calls=" + calls + "\\n"); }
      };
    }
  `;
  const preload = `import {registerHooks} from "node:module"; registerHooks({ resolve(specifier, context, next) { if (specifier === "wrangler") return {url: ${JSON.stringify(dataURL(mockWrangler))}, shortCircuit: true}; return next(specifier, context); } });`;
  return spawnSync(process.execPath, ["--import", dataURL(preload), "tools/bash.mjs", ...args], { input, encoding: "utf8", timeout: 15_000, env: { ...process.env, TELEGRAM_USER_ID: "", HOST_SECRET: "fixture-host-secret" } });
}

describe("debug CLI without Cloudflare access", () => {
  it("shows help and rejects invalid arguments without starting a session", () => {
    expect(cli(["--help"]).stdout).toContain("Read-only by default");
    for (const args of [[], ["--user", "../123"], ["--user", "9007199254740992"], ["--user", "123", "-c", " "], ...["0", "-1", "NaN", "Infinity", "2147483.648"].map(timeout => ["--user", "123", `--timeout=${timeout}`])]) {
      const result = cli(args);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("Production:");
    }
  });

  it("runs a one-shot command, preserves its exit code and always stops the session", () => {
    const success = cli(["--user", "123", "-c", "pwd"]);
    expect(success.status, success.stderr).toBe(0);
    expect(success.stdout).toBe("/custom/123\n");
    expect(success.stderr).toContain("read-only");
    expect(success.stderr).toContain("fixture stopped; calls=1");
    const failure = cli(["--user", "123", "-c", "printf failed >&2; exit 7"]);
    expect(failure.status, failure.stderr).toBe(7);
    expect(failure.stderr).toContain("failed");
    expect(failure.stderr).toContain("fixture stopped; calls=1");
  });

  it("keeps line-to-line state and supports explicit writes without exposing host secrets", () => {
    const result = cli(["--user", "123", "--write"], 'cd skills; VALUE=kept\npwd; printf "$VALUE\\n"; cat file.txt\nenv\nexit\nprintf not-run\n');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("/custom/123/skills\nkept\nfixture");
    expect(result.stdout).not.toMatch(/fixture-host-secret|HOST_SECRET|not-run/);
    expect(result.stderr).toContain("READ-WRITE");
    expect(result.stderr).toContain("fixture stopped; calls=4");
  });

  it("stops on transport failure without retrying an uncertain command", () => {
    const result = cli(["--user", "123", "--write", "-c", "lost"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("simulated lost response");
    expect(result.stderr).toContain("fixture stopped; calls=1");
  });

  it("announces connection before accepting commands after a delayed startup", () => {
    const result = cli(["--user", "123"], "pwd\nexit\n", "delay");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("/custom/123\n/custom/123\n");
    expect(result.stderr.indexOf("Connecting to the production filesystem...")).toBeLessThan(result.stderr.indexOf("Connected. just-bash:"));
    expect(result.stderr.indexOf("fixture initial response ready")).toBeLessThan(result.stderr.indexOf("Connected. just-bash:"));
    expect(result.stderr).toContain("fixture stopped; calls=2");
  });

  it.each(["pending", "pending-body"])("times out a stalled request without claiming connection or retrying: %s", scenario => {
    const result = cli(["--user", "123", "--timeout", "0.05"], "", scenario);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Remote request timed out after 0.05s");
    expect(result.stderr).not.toContain("Connected. just-bash:");
    expect(result.stderr).toContain("fixture stopped; calls=1");
  });

  it("reports uncertain writes after timeout and never resends the command", () => {
    const result = cli(["--user", "123", "--write", "--timeout", "0.05", "-c", "printf changed > file.txt"], undefined, "pending");
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Remote writes may have completed");
    expect(result.stderr).toContain("fixture stopped; calls=1");
  });

  it("shows progress while the initial remote request is still pending", () => {
    const result = cli(["--user", "123", "--timeout", "5.1"], "", "pending");
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Waiting for Cloudflare and the production filesystem");
    expect(result.stderr).toContain("Remote request timed out after 5.1s");
    expect(result.stderr).not.toContain("Connected. just-bash:");
    expect(result.stderr).toContain("fixture stopped; calls=1");
  });

  it("cancels a pending startup request with Ctrl+C and stops the session", () => {
    const result = cli(["--user", "123", "--write"], "", "interrupt");
    expect(result.status, result.stderr).toBe(130);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("Connected. just-bash:");
    expect(result.stderr).not.toContain("timed out");
    expect(result.stderr).toContain("fixture stopped; calls=1");
  });

  it("reports Cloudflare non-JSON network errors without exposing the session token", () => {
    const result = cli(["--user", "123", "-c", "pwd"], undefined, "network-error");
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("non-JSON response (HTTP 502): Error: Network connection lost. [redacted]");
    expect(result.stderr).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(result.stderr).toContain("fixture stopped; calls=1");
  });
});
