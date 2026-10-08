import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { MAX_FILE_BYTES } from "../src/memory/store.js";

const webhook = "test-webhook-secret";
const received: { text: string; chat_id: number }[] = [];
const outbound: string[] = [];
const voices: { chatId: string; bytes: number; replyTo?: number }[] = [];
const compactHistory = Array.from({ length: 6 }, (_, index) => `old-fact-${index}\n${"history ".repeat(4000)}`);
let speechCalls = 0;
let ambiguousVoiceOnce = false;
let rejectOnce = false;
let ambiguousOnce = false;
let mf: Miniflare;
let directory: string;
let bundle: string;
let migrationBundle: string;

async function responseJSON(response: Response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Worker returned non-JSON (HTTP ${response.status}): ${text.slice(0, 1500)}`); }
}

async function runtime(className = "TestAgent", state = "default", script = bundle) {
  const instance = new Miniflare({
    modules: [{ type: "ESModule", path: script }], modulesRoot: directory,
    compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { AGENT: { className, useSQLite: true, unsafeUniqueKey: "pi-durable-test-agent" } }, durableObjectsPersist: path.join(directory, state, "objects"),
    bindings: { TELEGRAM_USER_ID: "123", TELEGRAM_BOT_TOKEN: "test-bot", TELEGRAM_WEBHOOK_SECRET: webhook, OPENROUTER_API_KEY: "not-a-real-key", MEMORY_PREFIX: "hermes/" },
    outboundService: async (request) => {
      const url = new URL(request.url);
      outbound.push(url.hostname);
      if (url.hostname === "openrouter.ai" && url.pathname === "/api/v1/audio/speech") {
        speechCalls++;
        expect(request.headers.get("authorization")).toBe("Bearer not-a-real-key");
        expect(await request.json()).toEqual({ model: "bytedance-seed/seed-audio-1-0", input: "你好，这是本地语音测试。", response_format: "mp3" });
        const bytes = new Uint8Array(512); bytes.set([0x49, 0x44, 0x33]);
        return new Response(bytes, { headers: { "content-type": "audio/mpeg" } });
      }
      if (url.hostname === "api.telegram.org" && url.pathname === "/bottest-bot/sendVoice") {
        if (ambiguousVoiceOnce) { ambiguousVoiceOnce = false; throw new Error("simulated uncertain voice upload"); }
        const form = await request.formData();
        const audio = form.get("voice") as File;
        expect(audio.name).toBe("speech.mp3");
        expect(audio.type).toBe("audio/mpeg");
        expect(new Uint8Array(await audio.arrayBuffer()).slice(0, 3)).toEqual(new Uint8Array([0x49, 0x44, 0x33]));
        voices.push({ chatId: String(form.get("chat_id")), bytes: audio.size, ...(form.get("reply_parameters") ? { replyTo: JSON.parse(form.get("reply_parameters") as string).message_id } : {}) });
        return Response.json({ ok: true, result: { message_id: 10_000 + voices.length } });
      }
      if (url.hostname === "api.telegram.org" && url.pathname === "/bottest-bot/sendMessage") {
        if (ambiguousOnce) { ambiguousOnce = false; throw new Error("simulated network failure"); }
        if (rejectOnce) { rejectOnce = false; return Response.json({ ok: false, parameters: { retry_after: 1 } }, { status: 429 }); }
        received.push(await request.json() as { text: string; chat_id: number });
        return Response.json({ ok: true, result: { message_id: received.length } });
      }
      if (url.hostname === "cloudflare-dns.com") return Response.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "8.8.8.8" }] : [] });
      if (url.hostname === "example.com") return new Response("<title>Fixture</title><article><p>公开网页正文</p></article>", { headers: { "content-type": "text/html" } });
      if (url.hostname === "openrouter.ai" && url.pathname === "/api/v1/chat/completions") {
        expect(request.headers.get("authorization")).toBe("Bearer not-a-real-key");
        const body = await request.json() as { model: string; stream: boolean };
        expect(body).toMatchObject({ model: "xiaomi/mimo-v2.6-flash", stream: true });
        const chunk = { id: "test-completion", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "OpenRouter 本地完成。" }, finish_reason: null }] };
        const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      throw new Error("Real outbound network is forbidden during tests");
    },
  });
  await instance.ready;
  return instance;
}

async function probe(route: string, method = "GET", body?: unknown) {
  const namespace = await mf.getDurableObjectNamespace("AGENT");
  const response = await namespace.get(namespace.idFromName("123")).fetch(`https://agent.internal${route}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" } }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await responseJSON(response) };
}

async function telegram(updateId: number, text: string, from = 123, secret = webhook) {
  const response = await mf.dispatchFetch("https://agent.invalid/telegram/webhook", {
    method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({ update_id: updateId, message: { message_id: updateId + 1, from: { id: from }, chat: { id: 123, type: "private" }, text } }),
  });
  return { status: response.status, body: await responseJSON(response) };
}

async function waitJob(id: string) {
  for (let i = 0; i < 100; i++) {
    const result = await probe(`/test/jobs/${id}`);
    if (result.body?.status === "complete" || result.body?.status === "failed") return result.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Local job did not finish");
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-tests-"));
  bundle = path.join(directory, "worker.js");
  await build({ entryPoints: ["test/runtime.worker.ts"], outfile: bundle, bundle: true, format: "esm", platform: "browser", target: "es2022", conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"], logLevel: "silent" });
  migrationBundle = path.join(directory, "migration.js");
  await build({ entryPoints: ["scripts/migrate-files.worker.ts"], outfile: migrationBundle, bundle: true, format: "esm", platform: "browser", target: "es2022", conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"], logLevel: "silent" });
  mf = await runtime();
}, 30_000);

afterAll(async () => { await mf?.dispose(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

describe.sequential("real local Workers / SQLite Durable Object (no R2 binding)", () => {
  it("exposes only POST /telegram/webhook and protects it", async () => {
    for (const [method, route] of [
      ["GET", "/"], ["GET", "/health"],
      ["GET", "/api/telegram/status"], ["GET", "/api/telegram/latest"], ["POST", "/api/telegram/webhook"],
      ["POST", "/api/chat"], ["GET", `/api/jobs/${"a".repeat(64)}`],
      ["GET", "/api/memory/files"], ["GET", "/api/memory/file?path=MEMORY.md"], ["PUT", "/api/memory/file?path=MEMORY.md"],
      ["GET", "/api/wakeup"], ["POST", "/api/wakeup"], ["DELETE", "/api/wakeup"],
      ["POST", "/enqueue"], ["POST", "/wakeup"], ["GET", "/memory/files"],
      ["GET", "/test/memory/file?path=MEMORY.md"], ["GET", "/test/wakeup"], ["GET", `/test/jobs/${"a".repeat(64)}`],
      ["GET", "/telegram/webhook"], ["PUT", "/telegram/webhook"], ["DELETE", "/telegram/webhook"], ["OPTIONS", "/telegram/webhook"],
    ]) {
      const response = await mf.dispatchFetch(`https://agent.invalid${route}`, { method, headers: { authorization: "Bearer obsolete-admin-token-at-least-32-characters" } });
      expect(response.status, `${method} ${route}`).toBe(404);
    }
    expect((await telegram(1, "hello", 123, "wrong-secret")).status).toBe(401);
    expect((await telegram(1, "hello", 456)).body.ignored).toBe(true);
  });

  it("executes a real Pi Durable tool and deduplicates incoming Telegram updates", async () => {
    const before = received.length;
    const [first, duplicate] = await Promise.all([telegram(42, "remember"), telegram(42, "remember")]);
    expect(first.status).toBe(200);
    expect(duplicate.body.id).toBe(first.body.id);
    const job = await waitJob(first.body.id);
    expect(job.status, `${job.error}; outbound: ${outbound.join(",")}`).toBe("complete");
    expect(job.submissionId).toBeTypeOf("number");
    expect(received.length).toBe(before + 1);
    const memory = await probe("/test/memory/file?path=MEMORY.md");
    expect(memory.body.content.match(/测试用户喜欢简洁回答/g)).toHaveLength(1);
  });

  it("detects a requestId replay with a different body", async () => {
    expect((await telegram(42, "different input")).status).toBe(409);
  });

  it("handles short /compact without generating a chat reply and keeps Telegram access controls", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "compact-short");
    try {
      expect((await telegram(1, "/compact", 456)).body.ignored).toBe(true);
      expect((await telegram(1, "/compact", 123, "wrong-secret")).status).toBe(401);
      const queued = await telegram(1, " /compact\n");
      const job = await waitJob(queued.body.id);
      expect(job).toMatchObject({ kind: "compact", status: "complete", compactionTaskId: expect.any(Number), parts: ["当前上下文较短，无需压缩。"] });
      expect(job.submissionId).toBeUndefined();
      expect(job.speech).toBeUndefined();
      expect((await probe("/test/context")).body.context.messages).toEqual([]);
      const normal = await telegram(2, "/compactness");
      expect(await waitJob(normal.body.id)).toMatchObject({ kind: "user", parts: ["本地测试回答。"] });
    } finally { await mf.dispose(); mf = previous; }
  });

  it("places a manual compaction summary, preserves history/files and deduplicates across restart", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "compact-history");
    try {
      expect((await probe("/test/context", "PUT", compactHistory)).status).toBe(200);
      const memory = (await probe("/test/memory/file?path=MEMORY.md", "PUT", { content: "保留长期记忆", etag: null })).body;
      const before = received.length;
      rejectOnce = true;
      const [queued, duplicate] = await Promise.all([telegram(1, "/compact"), telegram(1, "/compact")]);
      expect(queued.status).toBe(200);
      expect(duplicate.body.id).toBe(queued.body.id);
      const job = await waitJob(queued.body.id);
      expect(job).toMatchObject({ kind: "compact", status: "complete", parts: ["上下文已压缩，历史记录和记忆文件已保留。"] });
      expect(received.length).toBe(before + 1);
      expect(received.at(-1)).toMatchObject({ chat_id: 123, reply_parameters: { message_id: 2 } });
      const view = (await probe("/test/context")).body;
      expect(view.context.head).toMatchObject({ kind: "pi.compaction", data: { reason: "manual" } });
      expect(JSON.stringify(view.context.messages)).toContain("测试压缩摘要");
      expect(JSON.stringify(view.context.messages)).not.toContain("old-fact-0");
      expect(view.entries.filter((entry: { kind: string }) => entry.kind === "pi.user")).toHaveLength(compactHistory.length);
      expect(JSON.stringify(view.entries)).toContain("old-fact-0");
      expect(JSON.stringify(view.entries)).not.toContain("/compact");
      expect((await probe("/test/memory/file?path=MEMORY.md")).body).toEqual(memory);
      await mf.dispose();
      mf = await runtime("TestAgent", "compact-history");
      const repeated = await telegram(1, "/compact");
      expect((await waitJob(repeated.body.id)).compactionTaskId).toBe(job.compactionTaskId);
      expect(received.length).toBe(before + 1);
      const reopened = (await probe("/test/context")).body;
      expect(reopened.context).toEqual(view.context);
      expect(reopened.entries.filter((entry: { kind: string }) => entry.kind === "pi.compaction")).toHaveLength(1);
      expect((await probe(`/test/jobs/${job.id}`, "PUT")).status).toBe(200);
      await mf.dispose();
      mf = await runtime("TestAgent", "compact-history");
      const recovered = await telegram(1, "/compact");
      expect(await waitJob(recovered.body.id)).toMatchObject({ status: "complete", compactionTaskId: job.compactionTaskId, parts: job.parts });
      expect((await probe("/test/context")).body).toEqual(reopened);
      expect(received.length).toBe(before + 2);
      const normal = await telegram(2, "hello");
      expect((await waitJob(normal.body.id)).status).toBe("complete");
    } finally { await mf.dispose(); mf = previous; }
  });

  it("reports failed compaction without deleting history or installing an incomplete summary", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "compact-failure");
    try {
      expect((await probe("/test/context", "PUT", compactHistory.map(message => `compaction-failure\n${message}`))).status).toBe(200);
      const original = (await probe("/test/context")).body;
      const queued = await telegram(1, "/compact");
      const job = await waitJob(queued.body.id);
      expect(job).toMatchObject({ status: "failed", error: "compaction_failed", parts: ["上下文压缩未完成，请稍后重试；历史记录和记忆文件未删除。"] });
      expect((await probe("/test/context")).body).toEqual(original);
      const duplicate = await telegram(1, "/compact");
      expect((await waitJob(duplicate.body.id)).compactionTaskId).toBe(job.compactionTaskId);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("runs Web Access through Pi Durable without external calls", async () => {
    const before = outbound.length;
    const queued = await telegram(48, "读取网页");
    expect(queued.status).toBe(200);
    const job = await waitJob(queued.body.id);
    expect(job.status).toBe("complete");
    expect(job.parts).toEqual(["本地工具执行完成。"]);
    expect(outbound.slice(before)).toContain("example.com");
    expect(outbound.slice(before)).toContain("cloudflare-dns.com");
  });

  it("preserves state across a runtime restart and does not resend completed jobs", async () => {
    const before = received.length;
    await mf.dispose();
    mf = await runtime();
    const repeated = await telegram(42, "remember");
    expect((await waitJob(repeated.body.id)).status).toBe("complete");
    expect(received.length).toBe(before);
    expect((await probe("/test/memory/file?path=MEMORY.md")).body.content.match(/测试用户喜欢简洁回答/g)).toHaveLength(1);
  });

  it("retries a known Telegram 429 without re-running the memory tool", async () => {
    const count = async () => (await probe("/test/memory/file?path=MEMORY.md")).body.content.match(/测试用户喜欢简洁回答/g)?.length ?? 0;
    const before = await count();
    rejectOnce = true;
    const queued = await telegram(43, "remember");
    expect((await waitJob(queued.body.id)).status).toBe("complete");
    expect(await count()).toBe(before + 1);
  });

  it("does not automatically resend an uncertain outgoing delivery", async () => {
    ambiguousOnce = true;
    const before = received.length;
    const queued = await telegram(44, "hello");
    const job = await waitJob(queued.body.id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("telegram_delivery_uncertain");
    const repeated = await telegram(44, "hello");
    expect((await waitJob(repeated.body.id)).error).toBe("telegram_delivery_uncertain");
    expect(received.length).toBe(before);
  });

  it("runs the speech tool, uploads native multipart voice and deduplicates repeated model calls/updates", async () => {
    const before = voices.length;
    const generated = speechCalls;
    const queued = await telegram(46, "speak-twice");
    const job = await waitJob(queued.body.id);
    expect(job.status).toBe("complete");
    expect(job.speech).toMatchObject({ status: "sent", messageId: 10_000 + before + 1, bytes: 512 });
    expect(voices.at(-1)).toEqual({ chatId: "123", bytes: 512, replyTo: 47 });
    expect(voices.length).toBe(before + 1);
    expect(speechCalls).toBe(generated + 1);
    await mf.dispose();
    mf = await runtime();
    const duplicate = await telegram(46, "speak-twice");
    expect((await waitJob(duplicate.body.id)).speech).toEqual(job.speech);
    expect(voices.length).toBe(before + 1);
    expect(speechCalls).toBe(generated + 1);
  });

  it("reports uncertain voice delivery without automatic retry across runtime restart", async () => {
    const before = voices.length;
    const generated = speechCalls;
    ambiguousVoiceOnce = true;
    const queued = await telegram(47, "speak");
    const job = await waitJob(queued.body.id);
    expect(job.speech).toMatchObject({ status: "uncertain", error: "speech_delivery_uncertain_check_telegram" });
    expect(job.parts.join("")).toContain("不会自动重试");
    await mf.dispose();
    mf = await runtime();
    const duplicate = await telegram(47, "speak");
    expect((await waitJob(duplicate.body.id)).speech.status).toBe("uncertain");
    expect(voices.length).toBe(before);
    expect(speechCalls).toBe(generated + 1);
  });

  it("runs the scheduled handler, keeps active wakeups idempotent and accepts owner confirmation", async () => {
    const previous = mf;
    const scheduled = await runtime("TestAgent", "scheduled");
    mf = scheduled;
    try {
      const worker = await scheduled.getWorker();
      const event = { cron: "0 22 * * *", scheduledTime: new Date("2026-10-07T22:00:00Z") };
      const before = received.length;
      const generated = speechCalls;
      const voiceCount = voices.length;
      expect((await worker.scheduled(event)).outcome).toBe("ok");
      const wakeup = (await probe("/test/wakeup")).body;
      expect(wakeup).toMatchObject({ active: true, intervalMs: 120_000 });
      expect(wakeup.deadline - wakeup.startedAt).toBe(360 * 60_000);
      const id = createHash("sha256").update(`wakeup:${wakeup.id}:0`).digest("hex");
      const reminder = await waitJob(id);
      expect(reminder.status).toBe("complete");
      expect(reminder.speech).toBeUndefined();
      expect(received.length).toBe(before + 1);
      expect(received.at(-1)?.text).toContain("起床啦");
      expect(speechCalls).toBe(generated);
      expect(voices.length).toBe(voiceCount);
      expect((await worker.scheduled(event)).outcome).toBe("ok");
      expect((await probe("/test/wakeup")).body.id).toBe(wakeup.id);
      expect(received.length).toBe(before + 1);
      const owner = await telegram(1001, "我醒了");
      expect((await waitJob(owner.body.id)).status).toBe("complete");
      expect((await probe("/test/wakeup")).body).toMatchObject({ active: false, confirmedAt: expect.any(Number) });
    } finally { mf = previous; await scheduled.dispose(); }
  });

  it("keeps legacy wakeup prompts free of audio-generation requirements", async () => {
    for (const name of ["start", "nudge"]) {
      const prompt = await fs.readFile(new URL(`../../.github/prompts/telegram-wakeup-${name}.md`, import.meta.url), "utf8");
      expect(prompt).not.toMatch(/\b(?:tts|voice|audio|speech)\b|语音/i);
    }
  });

  it("processes concurrently admitted distinct jobs without losing the alarm", async () => {
    const jobs = await Promise.all(Array.from({ length: 4 }, (_, index) => telegram(100 + index, `hello ${index}`)));
    expect(new Set(jobs.map((job) => job.body.id)).size).toBe(4);
    const done = await Promise.all(jobs.map((job) => waitJob(job.body.id)));
    expect(done.every((job) => job.status === "complete")).toBe(true);
    expect(new Set(done.map((job) => job.sequence)).size).toBe(4);
  });

  it("persists and reads nested Skill references through the actual Durable tools", async () => {
    const queued = await telegram(49, "persist-skill");
    expect((await waitJob(queued.body.id)).status).toBe("complete");
    expect((await probe("/test/memory/file?path=skills/test/nested/references/check.md")).body.content).toBe("持久化技能参考");
  });

  it("runs the production model runtime with the official OpenRouter provider and Workers Secrets", async () => {
    const fake = mf;
    const production = await runtime("ProbeAgent", "openrouter");
    mf = production;
    try {
      const before = outbound.length;
      const queued = await telegram(1, "只需回答一句话");
      const job = await waitJob(queued.body.id);
      expect(job.status).toBe("complete");
      expect(job.parts).toEqual(["OpenRouter 本地完成。"]);
      expect(outbound.slice(before)).toContain("openrouter.ai");
    } finally { mf = fake; await production.dispose(); }
  });

  it("runs bash through Pi with shared files, no secrets, and persistence across restart", async () => {
    const before = (await probe("/test/memory/file?path=MEMORY.md")).body;
    const calls = outbound.length;
    const queued = await telegram(50, "bash-files");
    const job = await waitJob(queued.body.id);
    expect(job.parts).toEqual(["本地工具执行完成。"]);
    expect(outbound.slice(calls)).toEqual(["api.telegram.org"]);
    const memory = (await probe("/test/memory/file?path=MEMORY.md")).body;
    expect(memory.content).toContain("bash 追加记忆");
    expect(memory.etag).not.toBe(before.etag);
    await mf.dispose();
    mf = await runtime();
    expect((await probe("/test/memory/file?path=skills/bash/demo/SKILL.md")).body.content).toBe("持久化技能参考");
    expect((await probe("/test/memory/file?path=MEMORY.md")).body).toEqual(memory);
    expect((await probe("/test/memory/file?path=MEMORY.md", "PUT", { content: "stale", etag: before.etag })).status).toBe(412);
  });

  it("migrates only by an authenticated manual call to a temporary Worker, then removes the endpoint", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "migration");
    try {
      const files = [
        { path: "MEMORY.md", content: "\ufeff旧中文记忆\n", etag: crypto.randomUUID() },
        { path: "skills/nested/large/reference.txt", content: "😀\n".repeat(50_000) + "x".repeat(MAX_FILE_BYTES - 250_000), etag: crypto.randomUUID() },
        { path: "skills/empty/SKILL.md", content: "", etag: crypto.randomUUID() },
      ];
      expect((await probe("/test/legacy", "PUT", files)).body.present).toBe(true);
      await mf.dispose();
      mf = await runtime("ProbeAgent", "migration");
      expect((await probe("/test/memory/file?path=MEMORY.md")).body.etag).toBeNull();
      expect((await probe("/test/legacy")).body.present).toBe(true);
      await mf.dispose();
      mf = await runtime("AgentBackend", "migration", migrationBundle);
      expect((await mf.dispatchFetch("https://agent.invalid/telegram/webhook", { method: "POST" })).status).toBe(503);
      const endpoint = "https://agent.invalid/migrate-files";
      expect((await mf.dispatchFetch(endpoint, { method: "POST" })).status).toBe(401);
      const headers = { "x-telegram-bot-api-secret-token": webhook };
      expect(await responseJSON(await mf.dispatchFetch(endpoint, { headers }))).toEqual({ legacyFiles: 3, files: 0, verified: 0 });
      expect(await responseJSON(await mf.dispatchFetch(endpoint, { method: "POST", headers }))).toEqual({ migrated: 3, verified: 3 });
      expect(await responseJSON(await mf.dispatchFetch(endpoint, { headers }))).toEqual({ legacyFiles: 3, files: 3, verified: 3 });
      expect((await mf.dispatchFetch(endpoint, { method: "POST", headers })).status).toBe(409);
      await mf.dispose();
      mf = await runtime("ProbeAgent", "migration");
      for (const file of files) expect((await probe(`/test/memory/file?path=${file.path}`)).body).toEqual(file);
      expect((await probe("/test/legacy")).body.present).toBe(true);
      expect((await mf.dispatchFetch(endpoint, { method: "POST", headers })).status).toBe(404);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("DO file writes reject stale versions and unsafe paths", async () => {
    const first = await probe("/test/memory/file?path=USER.md", "PUT", { content: "用户原稿", etag: null });
    const second = await probe("/test/memory/file?path=USER.md", "PUT", { content: "用户修正", etag: first.body.etag });
    expect(second.status).toBe(200);
    expect((await probe("/test/memory/file?path=USER.md", "PUT", { content: "stale", etag: first.body.etag })).status).toBe(412);
    expect((await probe("/test/memory/file?path=..%2FUSER.md")).status).toBe(400);
  });

  it("rejects concurrent DO file replacements of the same revision", async () => {
    const endpoint = "/test/memory/file?path=STANDING.md";
    const first = await probe(endpoint, "PUT", { content: "first", etag: null });
    const responses = await Promise.all(["edit A", "edit B"].map((content) => probe(endpoint, "PUT", { content, etag: first.body.etag })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    const winner = responses.find((response) => response.status === 200)!;
    expect((await probe(endpoint)).body).toEqual(winner.body);
    expect((await probe(endpoint, "PUT", { content: "no revision" })).status).toBe(412);
  });

  it("stores a 256 KiB Unicode Skill and preserves its exact content and revision across restart", async () => {
    const content = "😀\n".repeat(50_000) + "x".repeat(MAX_FILE_BYTES - 250_000);
    const endpoint = "/test/memory/file?path=skills/large/reference.txt";
    const saved = await probe(endpoint, "PUT", { content, etag: null });
    expect(saved.status).toBe(200);
    expect((await probe(endpoint)).body.content === content).toBe(true);
    await mf.dispose();
    mf = await runtime();
    const reread = await probe(endpoint);
    expect(reread.body.etag).toBe(saved.body.etag);
    expect(reread.body.content === content).toBe(true);
    expect((await probe(endpoint, "PUT", { content: content + "x", etag: saved.body.etag })).status).toBe(413);
    expect((await probe(endpoint)).body.etag).toBe(saved.body.etag);
  });
});
