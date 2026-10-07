import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { collectMemoryFiles } from "../scripts/memory-files.mjs";
import { MAX_FILE_BYTES } from "../src/memory/store.js";

const admin = "test-admin-token-at-least-thirty-two-characters";
const webhook = "test-webhook-secret";
const received: { text: string; chat_id: number }[] = [];
const outbound: string[] = [];
const voices: { chatId: string; bytes: number; replyTo?: number }[] = [];
let speechCalls = 0;
let ambiguousVoiceOnce = false;
let rejectOnce = false;
let ambiguousOnce = false;
let webhookUrl = "";
let webhookRejectOnce = false;
let mf: Miniflare;
let directory: string;
let bundle: string;

async function responseJSON(response: Response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Worker returned non-JSON (HTTP ${response.status}): ${text.slice(0, 1500)}`); }
}

async function runtime(className = "TestAgent", state = "default") {
  const instance = new Miniflare({
    modules: [{ type: "ESModule", path: bundle }], modulesRoot: directory,
    compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { AGENT: { className, useSQLite: true } }, durableObjectsPersist: path.join(directory, state, "objects"),
    bindings: { TELEGRAM_USER_ID: "123", TELEGRAM_BOT_TOKEN: "test-bot", TELEGRAM_WEBHOOK_SECRET: webhook, OPENROUTER_API_KEY: "not-a-real-key", AGENT_ADMIN_TOKEN: admin, MEMORY_PREFIX: "hermes/" },
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
      if (url.hostname === "api.telegram.org" && url.pathname.startsWith("/bottest-bot/")) {
        const method = url.pathname.split("/").at(-1);
        if (method === "getMe") return Response.json({ ok: true, result: { id: 789, is_bot: true, username: "test_bot" } });
        if (method === "getChat") return Response.json({ ok: true, result: { id: 123, type: "private" } });
        if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: webhookUrl, pending_update_count: 0 } });
        if (method === "setWebhook") {
          if (webhookRejectOnce) {
            webhookRejectOnce = false;
            return Response.json({ ok: false, error_code: 400, description: `Bad webhook: failed to resolve host ${admin} ${webhook}` }, { status: 400 });
          }
          const body = await request.json() as { url: string; secret_token: string; drop_pending_updates: boolean };
          expect(body.secret_token).toBe(webhook);
          expect(body.drop_pending_updates).toBe(false);
          webhookUrl = body.url;
          return Response.json({ ok: true, result: true });
        }
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

async function api(route: string, method = "GET", body?: unknown, authorization = true) {
  const response = await mf.dispatchFetch(`https://agent.invalid${route}`, {
    method, headers: { ...(authorization ? { authorization: `Bearer ${admin}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
    const result = await api(`/api/jobs/${id}`);
    if (result.body.status === "complete" || result.body.status === "failed") return result.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Local job did not finish");
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-tests-"));
  bundle = path.join(directory, "worker.js");
  await build({ entryPoints: ["test/runtime.worker.ts"], outfile: bundle, bundle: true, format: "esm", platform: "browser", target: "es2022", conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"], logLevel: "silent" });
  mf = await runtime();
}, 30_000);

afterAll(async () => { await mf?.dispose(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

describe.sequential("real local Workers / SQLite Durable Object (no R2 binding)", () => {
  it("has a public health check but protects administration and webhook", async () => {
    expect((await api("/health", "GET", undefined, false)).status).toBe(200);
    expect((await api("/api/memory/files", "GET", undefined, false)).status).toBe(401);
    expect((await telegram(1, "hello", 123, "wrong-secret")).status).toBe(401);
    expect((await telegram(1, "hello", 456)).body.ignored).toBe(true);
  });

  it("protects Telegram administration and registers only the current Worker origin", async () => {
    expect((await api("/api/telegram/status", "GET", undefined, false)).status).toBe(401);
    expect((await api("/api/telegram/latest", "GET", undefined, false)).status).toBe(401);
    expect((await api("/api/telegram/latest")).body).toEqual({ job: null });
    expect((await api("/api/telegram/webhook", "POST", { confirm: true }, false)).status).toBe(401);
    expect((await api("/api/telegram/webhook", "POST", {})).status).toBe(400);
    const status = await api("/api/telegram/status");
    expect(status.body.ownerChatReady).toBe(true);
    expect((await api("/api/telegram/webhook", "POST", { confirm: true, url: "https://not-the-worker.example/telegram/webhook" })).body.url).toBe("https://agent.invalid/telegram/webhook");
    expect((await api("/api/telegram/status")).body.webhook.url).toBe("https://agent.invalid/telegram/webhook");
  });

  it("returns safe Telegram setup diagnostics without exposing provider descriptions", async () => {
    webhookRejectOnce = true;
    const result = await api("/api/telegram/webhook", "POST", { confirm: true });
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: "Telegram API request failed", errorCode: 400, reason: "webhook_dns_failed", retryable: false, uncertain: false });
    expect(JSON.stringify(result.body)).not.toContain(admin);
    expect(JSON.stringify(result.body)).not.toContain(webhook);
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
    expect((await api("/api/telegram/latest")).body).toEqual({ job: {
      id: job.id, status: "complete", createdAt: job.createdAt, sentIds: job.sentIds,
    } });
    const memory = await api("/api/memory/file?path=MEMORY.md");
    expect(memory.body.content.match(/测试用户喜欢简洁回答/g)).toHaveLength(1);
  });

  it("detects a requestId replay with a different body", async () => {
    expect((await telegram(42, "different input")).status).toBe(409);
  });

  it("runs Web Access through Pi Durable without external calls", async () => {
    const before = outbound.length;
    const queued = await api("/api/chat", "POST", { requestId: "web", text: "读取网页" });
    expect(queued.status).toBe(202);
    const job = await waitJob(queued.body.id);
    expect(job.status).toBe("complete");
    expect(job.parts).toEqual(["本地工具执行完成。"]);
    expect(outbound.slice(before)).toContain("example.com");
    expect(outbound.slice(before)).toContain("cloudflare-dns.com");
    expect((await api("/api/telegram/latest")).body.job.id).toBe(createHash("sha256").update("telegram:42").digest("hex"));
  });

  it("preserves state across a runtime restart and does not resend completed jobs", async () => {
    const before = received.length;
    await mf.dispose();
    mf = await runtime();
    const repeated = await telegram(42, "remember");
    expect((await waitJob(repeated.body.id)).status).toBe("complete");
    expect(received.length).toBe(before);
    expect((await api("/api/telegram/latest")).body.job.id).toBe(repeated.body.id);
    expect((await api("/api/memory/file?path=MEMORY.md")).body.content.match(/测试用户喜欢简洁回答/g)).toHaveLength(1);
  });

  it("retries a known Telegram 429 without re-running the memory tool", async () => {
    const count = async () => (await api("/api/memory/file?path=MEMORY.md")).body.content.match(/测试用户喜欢简洁回答/g)?.length ?? 0;
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
    expect((await api("/api/telegram/latest")).body.job.speech.messageId).toBe(job.speech.messageId);
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

  it("starts wakeup reminders and stops them on an actual user confirmation", async () => {
    const generated = speechCalls;
    const voiceCount = voices.length;
    const start = await api("/api/wakeup", "POST", { maxMinutes: 1, intervalSeconds: 60 });
    expect(start.status).toBe(202);
    const id = createHash("sha256").update(`wakeup:${start.body.id}:0`).digest("hex");
    const reminder = await waitJob(id);
    expect(reminder.status).toBe("complete");
    expect(reminder.speech).toBeUndefined();
    expect(received.at(-1)?.text).toContain("起床啦");
    expect(speechCalls).toBe(generated);
    expect(voices.length).toBe(voiceCount);
    expect((await api("/api/wakeup")).body.active).toBe(true);
    const user = await telegram(45, "我醒了");
    expect((await waitJob(user.body.id)).status).toBe("complete");
    expect((await api("/api/wakeup")).body).toMatchObject({ active: false, confirmedAt: expect.any(Number) });
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
      const wakeup = (await api("/api/wakeup")).body;
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
      expect((await api("/api/wakeup")).body.id).toBe(wakeup.id);
      expect(received.length).toBe(before + 1);
      const owner = await telegram(1001, "我醒了");
      expect((await waitJob(owner.body.id)).status).toBe("complete");
      expect((await api("/api/wakeup")).body).toMatchObject({ active: false, confirmedAt: expect.any(Number) });
    } finally { mf = previous; await scheduled.dispose(); }
  });

  it("keeps legacy wakeup prompts free of audio-generation requirements", async () => {
    for (const name of ["start", "nudge"]) {
      const prompt = await fs.readFile(new URL(`../../.github/prompts/telegram-wakeup-${name}.md`, import.meta.url), "utf8");
      expect(prompt).not.toMatch(/\b(?:tts|voice|audio|speech)\b|语音/i);
    }
  });

  it("processes concurrently admitted distinct jobs without losing the alarm", async () => {
    const jobs = await Promise.all(Array.from({ length: 4 }, (_, index) => api("/api/chat", "POST", { requestId: `concurrent:${index}`, text: `hello ${index}` })));
    expect(new Set(jobs.map((job) => job.body.id)).size).toBe(4);
    const done = await Promise.all(jobs.map((job) => waitJob(job.body.id)));
    expect(done.every((job) => job.status === "complete")).toBe(true);
    expect(new Set(done.map((job) => job.sequence)).size).toBe(4);
  });

  it("persists and reads nested Skill references through the actual Durable tools", async () => {
    const queued = await api("/api/chat", "POST", { requestId: "skill", text: "persist-skill" });
    expect((await waitJob(queued.body.id)).status).toBe("complete");
    expect((await api("/api/memory/file?path=skills/test/nested/references/check.md")).body.content).toBe("持久化技能参考");
  });

  it("runs the unmodified production Agent with the official OpenRouter provider and Workers Secrets", async () => {
    const fake = mf;
    const production = await runtime("AgentBackend", "openrouter");
    mf = production;
    try {
      const before = outbound.length;
      const queued = await api("/api/chat", "POST", { requestId: "real-provider", text: "只需回答一句话" });
      const job = await waitJob(queued.body.id);
      expect(job.status).toBe("complete");
      expect(job.parts).toEqual(["OpenRouter 本地完成。"]);
      expect(outbound.slice(before)).toContain("openrouter.ai");
    } finally { mf = fake; await production.dispose(); }
  });

  it("DO file writes reject stale versions and unsafe paths", async () => {
    const first = await api("/api/memory/file?path=USER.md", "PUT", { content: "用户原稿", etag: null });
    const second = await api("/api/memory/file?path=USER.md", "PUT", { content: "用户修正", etag: first.body.etag });
    expect(second.status).toBe(200);
    expect((await api("/api/memory/file?path=USER.md", "PUT", { content: "stale", etag: first.body.etag })).status).toBe(412);
    expect((await api("/api/memory/file?path=..%2FUSER.md")).status).toBe(400);
  });

  it("rejects concurrent API replacements of the same revision", async () => {
    const endpoint = "/api/memory/file?path=STANDING.md";
    const first = await api(endpoint, "PUT", { content: "first", etag: null });
    const responses = await Promise.all(["edit A", "edit B"].map((content) => api(endpoint, "PUT", { content, etag: first.body.etag })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    const winner = responses.find((response) => response.status === 200)!;
    expect((await api(endpoint)).body).toEqual(winner.body);
    expect((await api(endpoint, "PUT", { content: "no revision" })).status).toBe(412);
  });

  it("stores a 256 KiB Unicode Skill and preserves its exact content and revision across restart", async () => {
    const content = "😀\n".repeat(50_000) + "x".repeat(MAX_FILE_BYTES - 250_000);
    const endpoint = "/api/memory/file?path=skills/large/reference.txt";
    const saved = await api(endpoint, "PUT", { content, etag: null });
    expect(saved.status).toBe(200);
    expect((await api(endpoint)).body.content === content).toBe(true);
    await mf.dispose();
    mf = await runtime();
    const reread = await api(endpoint);
    expect(reread.body.etag).toBe(saved.body.etag);
    expect(reread.body.content === content).toBe(true);
    expect((await api(endpoint, "PUT", { content: content + "x", etag: saved.body.etag })).status).toBe(413);
    expect((await api(endpoint)).body.etag).toBe(saved.body.etag);
  });

  it.skipIf(!process.env.HERMES_DEBUG_DIR)("imports the user's real file tree into local DO storage without modifying or logging its contents", async () => {
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const files = await collectMemoryFiles(process.env.HERMES_DEBUG_DIR!);
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const endpoint = `/api/memory/file?path=${encodeURIComponent(file.path)}`;
      const current = await api(endpoint);
      const result = await api(endpoint, "PUT", { content: file.content, etag: current.body.etag });
      expect(result.status).toBe(200);
      expect(digest(result.body.content)).toBe(digest(file.content));
    }
    const list = await api("/api/memory/files");
    expect(list.body.some((file: { path: string }) => file.path.endsWith("/references/game-bundle-patterns.md"))).toBe(true);
    await mf.dispose();
    mf = await runtime();
    for (const file of files) {
      const restored = await api(`/api/memory/file?path=${encodeURIComponent(file.path)}`);
      expect(digest(restored.body.content)).toBe(digest(file.content));
    }
    const memory = files.find((file: { path: string }) => file.path === "MEMORY.md")!;
    const query = memory.content.match(/[\p{L}\p{N}]{4,20}/u)?.[0];
    expect(Boolean(query)).toBe(true);
    const namespace = await mf.getDurableObjectNamespace("AGENT");
    const response = await namespace.get(namespace.idFromName("123")).fetch(`https://agent.internal/test/memory-probe?query=${encodeURIComponent(query!)}`);
    const probe = await responseJSON(response);
    expect(probe.skillCount).toBe(files.filter((file: { path: string }) => file.path.endsWith("/SKILL.md")).length);
    expect(probe.matchedPaths.includes("MEMORY.md")).toBe(true);
    const reread = await collectMemoryFiles(process.env.HERMES_DEBUG_DIR!);
    expect(reread.map((file: { path: string; content: string }) => [file.path, digest(file.content)])).toEqual(files.map((file: { path: string; content: string }) => [file.path, digest(file.content)]));
  });
});
