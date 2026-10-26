import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { MAX_FILE_BYTES } from "../src/memory/store.js";

const token = "fixture-debug-token";
let mf: Miniflare;
let directory: string;

async function run(command: string, write = false, env?: Record<string, string>) {
  const worker = await mf.getWorker(write ? "read-write" : "read-only");
  const response = await worker.fetch("https://debug.invalid/bash", {
    method: "POST", headers: { "content-type": "application/json", "x-debug-token": token },
    body: JSON.stringify({ command, env }),
  });
  expect(response.status).toBe(200);
  return await response.json() as { stdout: string; stderr: string; exitCode: number; env: Record<string, string> };
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
    for (const [route, method, secret, status] of [["/bash", "GET", token, 404], ["/other", "POST", token, 404], ["/bash", "POST", "wrong", 401], ["/bash", "POST", "", 401]] as const) {
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
});

const dataURL = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;

function cli(args: string[], input?: string) {
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
    for (const args of [[], ["--user", "../123"], ["--user", "9007199254740992"], ["--user", "123", "-c", " "]]) {
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
});
