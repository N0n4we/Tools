import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { MAX_FILE_BYTES } from "../src/memory/store.js";

const webhook = "test-webhook-secret";
const received: { text: string; chat_id: number; rich_message?: any; parse_mode?: string }[] = [];
const telegramCalls: { method: string; body: any }[] = [];
const receivedById = new Map<number, typeof received[number]>();
const sentMessageIds: number[] = [];
const deletedMessageIds = new Set<number>();
const incomingMessageIds = new Map<number, number>();
let nextTelegramId: number | undefined;
let rejectDeleteOnce = false;
let ambiguousDeleteOnce = false;
const outbound: string[] = [];
const voices: { chatId: string; bytes: number; replyTo?: number }[] = [];
const compactHistory = Array.from({ length: 6 }, (_, index) => `old-fact-${index}\n${"history ".repeat(4000)}`);
const toolText = (command: string, status = "done") => `bash: ${status}\n${JSON.stringify({ command }, null, 2)}`;
const intermediateAssistant = ["<blockquote expandable>中途思考内容。</blockquote>", "中途正文一。", "中途正文二。", toolText("printf '工具输出不能发送'; printf '工具错误输出不能发送' >&2; sleep 1")];
const finalAssistant = ["<blockquote expandable>最终思考内容。</blockquote>", "最终正文。"];
const wakeupAssistant = ["起床啦，开始新的一天。", toolText("sleep 1")];
let speechCalls = 0;
let ambiguousVoiceOnce = false;
let rejectOnce = false;
let ambiguousOnce = false;
let ambiguousEditOnce = false;
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
    bindings: { TELEGRAM_USER_ID: "123", TELEGRAM_BOT_TOKEN: "test-bot", TELEGRAM_WEBHOOK_SECRET: webhook, OPENROUTER_API_KEY: "not-a-real-key", PI_MODEL: "deepseek/deepseek-v4.1-flash-1017", MEMORY_PREFIX: "hermes/", WEB_SEARCH_PROVIDER: "exa", EXA_API_KEY: "test-exa-key" },
    outboundService: async (request) => {
      const url = new URL(request.url);
      outbound.push(url.hostname);
      if (url.hostname === "api.exa.ai" && url.pathname === "/search") {
        expect(request.method).toBe("POST");
        expect(request.headers.get("x-api-key")).toBe("test-exa-key");
        expect(await request.json()).toEqual({ query: "Cloudflare Workers", type: "auto", numResults: 3, contents: { highlights: { maxCharacters: 2_000 } } });
        return Response.json({ results: [{ title: "Workers", url: "https://example.com/story", highlights: ["Exa 搜索摘要"] }, { url: "https://127.0.0.1/private" }] });
      }
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
        const messageId = nextTelegramId === undefined ? 10_000 + voices.length : nextTelegramId++;
        sentMessageIds.push(messageId);
        return Response.json({ ok: true, result: { message_id: messageId } });
      }
      if (url.hostname === "api.telegram.org" && url.pathname === "/bottest-bot/deleteMessages") {
        const body = await request.json() as { chat_id: number; message_ids: number[] };
        telegramCalls.push({ method: "deleteMessages", body });
        expect(body.chat_id).toBe(123);
        expect(body.message_ids.length).toBeGreaterThan(0);
        expect(body.message_ids.length).toBeLessThanOrEqual(100);
        if (rejectDeleteOnce) { rejectDeleteOnce = false; return Response.json({ ok: false, description: "message can't be deleted" }, { status: 400 }); }
        for (const id of body.message_ids) deletedMessageIds.add(id);
        if (ambiguousDeleteOnce) { ambiguousDeleteOnce = false; throw new Error("simulated lost delete receipt"); }
        return Response.json({ ok: true, result: true });
      }
      if (url.hostname === "api.telegram.org" && ["/bottest-bot/sendMessage", "/bottest-bot/sendRichMessage", "/bottest-bot/editMessageText"].includes(url.pathname)) {
        if (ambiguousOnce) { ambiguousOnce = false; throw new Error("simulated network failure"); }
        if (ambiguousEditOnce && url.pathname.endsWith("/editMessageText")) { ambiguousEditOnce = false; throw new Error("simulated uncertain edit"); }
        if (rejectOnce) { rejectOnce = false; return Response.json({ ok: false, parameters: { retry_after: 1 } }, { status: 429 }); }
        const body = await request.json() as any;
        const method = url.pathname.split("/").at(-1)!;
        telegramCalls.push({ method, body });
        const tool = body.rich_message?.blocks?.[0];
        const text = body.text ?? body.rich_message?.markdown ?? `${tool.summary[0].text} ${tool.summary[2].text}\n${tool.blocks[0].blocks[0].text}`;
        const rendered = { ...body, text };
        let messageId: number;
        if (method === "editMessageText") {
          expect(receivedById.has(body.message_id)).toBe(true);
          Object.assign(receivedById.get(body.message_id)!, rendered);
          messageId = body.message_id;
        } else {
          received.push(rendered);
          messageId = nextTelegramId === undefined ? received.length : nextTelegramId++;
          receivedById.set(messageId, rendered);
          sentMessageIds.push(messageId);
        }
        return Response.json({ ok: true, result: { message_id: messageId } });
      }
      if (url.hostname === "cloudflare-dns.com") return Response.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "8.8.8.8" }] : [] });
      if (url.hostname === "example.com") {
        for (const name of ["authorization", "cookie", "x-api-key"]) expect(request.headers.has(name)).toBe(false);
        return new Response("<title>Fixture</title><article><p>公开网页正文</p></article>", { headers: { "content-type": "text/html" } });
      }
      if (url.hostname === "openrouter.ai" && url.pathname === "/api/v1/chat/completions") {
        expect(request.headers.get("authorization")).toBe("Bearer not-a-real-key");
        const body = await request.json() as { model: string; stream: boolean; messages: { role: string; content: unknown }[] };
        expect(body).toMatchObject({ model: "deepseek/deepseek-v4.1-flash-1017", stream: true, max_completion_tokens: 80_000, reasoning: { effort: "medium" } });
        const system = JSON.stringify(body.messages.filter(message => message.role === "system"));
        expect(system).not.toContain("legacy-removed-");
        expect(system).toContain("telegram-speech");
        for (const message of body.messages.filter(message => ["user", "assistant", "tool"].includes(message.role))) {
          expect(message.content).toEqual(expect.stringMatching(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\n/));
        }
        const thinking = { id: "test-completion", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", reasoning: "OpenRouter 可见思考。" }, finish_reason: null }] };
        const chunk = { id: "test-completion", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "OpenRouter 本地完成。" }, finish_reason: null }] };
        const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
        return new Response(`data: ${JSON.stringify(thinking)}\n\ndata: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
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
  if (nextTelegramId !== undefined && !incomingMessageIds.has(updateId)) incomingMessageIds.set(updateId, nextTelegramId++);
  const response = await mf.dispatchFetch("https://agent.invalid/telegram/webhook", {
    method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({ update_id: updateId, message: { message_id: nextTelegramId === undefined ? updateId + 1 : incomingMessageIds.get(updateId), from: { id: from }, chat: { id: 123, type: "private" }, text } }),
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

async function waitMessages(count: number) {
  for (let i = 0; i < 100 && received.length < count; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(received.length).toBeGreaterThanOrEqual(count);
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
      ["GET", "/test/deliveries"],
      ["GET", "/telegram/webhook"], ["PUT", "/telegram/webhook"], ["DELETE", "/telegram/webhook"], ["OPTIONS", "/telegram/webhook"],
    ]) {
      const response = await mf.dispatchFetch(`https://agent.invalid${route}`, { method, headers: { authorization: "Bearer obsolete-admin-token-at-least-32-characters" } });
      expect(response.status, `${method} ${route}`).toBe(404);
    }
    expect((await telegram(1, "hello", 123, "wrong-secret")).status).toBe(401);
    expect((await telegram(1, "hello", 456)).body.ignored).toBe(true);
  });

  it("uses bash for memory with only bash, web and speech tools, and deduplicates Telegram updates", async () => {
    const before = received.length;
    const [first, duplicate] = await Promise.all([telegram(42, "remember"), telegram(42, "remember")]);
    expect(first.status).toBe(200);
    expect(duplicate.body.id).toBe(first.body.id);
    const job = await waitJob(first.body.id);
    expect(job.status, `${job.error}; outbound: ${outbound.join(",")}`).toBe("complete");
    expect(job.submissionId).toBeTypeOf("number");
    expect(received.length).toBe(before + 2);
    expect(received[before]?.text).toContain("bash: done");
    expect(received[before + 1]?.text).toBe("本地工具执行完成。");
    const memory = await probe("/test/memory/file?path=MEMORY.md");
    expect(memory.body.content.match(/测试用户喜欢简洁回答/g)).toHaveLength(1);
  });

  it("detects a requestId replay with a different body", async () => {
    expect((await telegram(42, "different input")).status).toBe(409);
  });

  it("timestamps model messages in Beijing time across midnight without rewriting history or Telegram output", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "message-time");
    try {
      const userTime = Date.parse("2026-12-31T15:59:59Z");
      const assistantTime = Date.parse("2026-12-31T16:00:00Z");
      await probe(`/test/context?timestamp=${userTime}`, "PUT", ["历史用户消息"]);
      await probe(`/test/context?timestamp=${assistantTime}`, "POST", ["历史助手消息"]);
      const before = received.length;
      const queued = await telegram(1, "remember");
      expect(await waitJob(queued.body.id)).toMatchObject({ status: "complete" });
      const messages = (await probe("/test/context")).body.context.messages.filter((message: { role: string }) => message.role !== "system");
      expect(messages.slice(0, 2)).toMatchObject([
        { role: "user", content: "历史用户消息", timestamp: userTime },
        { role: "assistant", content: [{ type: "text", text: "历史助手消息" }], timestamp: assistantTime },
      ]);
      expect(JSON.stringify(messages)).not.toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
      expect(received.slice(before).map(message => message.text)).toEqual([
        toolText("printf '测试用户喜欢简洁回答\\n' >> MEMORY.md; cat MEMORY.md"), "本地工具执行完成。",
      ]);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("loads role formatting before the first reply and keeps echoed timestamps out of the second Telegram reply across restart", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "role-format");
    try {
      const user = (await probe("/test/memory/file?path=USER.md", "PUT", { content: "你是测试角色小岚。" })).body;
      const standing = (await probe("/test/memory/file?path=STANDING.md", "PUT", { content: "动作必须用（）包裹。" })).body;
      const before = received.length;
      const first = await telegram(1, "role-format first");
      const firstJob = await waitJob(first.body.id);
      expect(firstJob.status, JSON.stringify(firstJob)).toBe("complete");
      await mf.dispose();
      mf = await runtime("TestAgent", "role-format");
      const second = await telegram(2, "role-format second");
      expect(await waitJob(second.body.id)).toMatchObject({ status: "complete" });
      expect(received.slice(before).map(message => message.text)).toEqual(["（轻轻点头）第一轮。", "（微笑）第二轮。"]);
      expect((await probe("/test/memory/file?path=USER.md")).body).toEqual(user);
      expect((await probe("/test/memory/file?path=STANDING.md")).body).toEqual(standing);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("handles /compact on empty context without generating a summary and keeps Telegram access controls", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "compact-short");
    try {
      expect((await telegram(1, "/compact", 456)).body.ignored).toBe(true);
      expect((await telegram(1, "/compact", 123, "wrong-secret")).status).toBe(401);
      const queued = await telegram(1, " /compact\n");
      const job = await waitJob(queued.body.id);
      expect(job).toMatchObject({ kind: "compact", status: "complete", compactionTaskId: expect.any(Number), parts: ["当前没有可压缩的历史内容。"] });
      expect(job.submissionId).toBeUndefined();
      expect(job.speech).toBeUndefined();
      expect((await probe("/test/context")).body.context.messages).toEqual([]);
      const normal = await telegram(2, "/compactness");
      expect(await waitJob(normal.body.id)).toMatchObject({ kind: "user", status: "complete" });
      expect(received.at(-1)?.text).toBe("本地测试回答。");
    } finally { await mf.dispose(); mf = previous; }
  });

  it.each([
    { name: "short", history: ["old-fact-0", "recent-fact"] },
    { name: "long", history: compactHistory },
  ])("compacts $name history, preserves history/files and deduplicates across restart", async ({ name, history }) => {
    const previous = mf;
    mf = await runtime("TestAgent", `compact-${name}-history`);
    try {
      expect((await probe("/test/context", "PUT", history)).status).toBe(200);
      const memory = (await probe("/test/memory/file?path=MEMORY.md", "PUT", { content: "保留长期记忆" })).body;
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
      expect(view.context.messages.at(-1)).toMatchObject({ role: "user", content: history.at(-1) });
      expect(view.entries.filter((entry: { kind: string }) => entry.kind === "pi.user")).toHaveLength(history.length);
      expect(JSON.stringify(view.entries)).toContain("old-fact-0");
      expect(JSON.stringify(view.entries)).not.toContain("/compact");
      expect((await probe("/test/memory/file?path=MEMORY.md")).body).toEqual(memory);
      await mf.dispose();
      mf = await runtime("TestAgent", `compact-${name}-history`);
      const repeated = await telegram(1, "/compact");
      expect((await waitJob(repeated.body.id)).compactionTaskId).toBe(job.compactionTaskId);
      expect(received.length).toBe(before + 1);
      const reopened = (await probe("/test/context")).body;
      expect(reopened.context).toEqual(view.context);
      expect(reopened.entries.filter((entry: { kind: string }) => entry.kind === "pi.compaction")).toHaveLength(1);
      expect((await probe(`/test/jobs/${job.id}`, "PUT")).status).toBe(200);
      await mf.dispose();
      mf = await runtime("TestAgent", `compact-${name}-history`);
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
      expect(job).toMatchObject({ status: "failed", error: "compaction_failed", parts: ["Summarization hit the token limit; the summary is incomplete"] });
      expect(received.at(-1)?.text).toBe(job.parts[0]);
      expect((await probe("/test/context")).body).toEqual(original);
      const duplicate = await telegram(1, "/compact");
      expect((await waitJob(duplicate.body.id)).compactionTaskId).toBe(job.compactionTaskId);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("handles exact /new on a fresh session without a model call and keeps Telegram access controls", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "new-empty");
    try {
      expect((await telegram(1, "/new", 456)).body.ignored).toBe(true);
      expect((await telegram(1, "/new", 123, "wrong-secret")).status).toBe(401);
      const before = outbound.length;
      const queued = await telegram(1, " /new\n");
      const job = await waitJob(queued.body.id);
      expect(job).toMatchObject({ kind: "new", status: "complete", parts: ["已开始新会话，旧会话记录已丢弃；记忆和 Skill 文件已保留。"] });
      expect(job.submissionId).toBeUndefined();
      expect(job.compactionTaskId).toBeUndefined();
      expect(job.speech).toBeUndefined();
      expect(outbound.slice(before)).toEqual(["api.telegram.org"]);
      const view = (await probe("/test/context")).body;
      expect(view.context.messages).toEqual([]);
      expect(view.entries).toEqual([]);
      for (const input of ["/newness", "/new extra"]) {
        const normal = await telegram(input === "/newness" ? 2 : 3, input);
        expect(await waitJob(normal.body.id)).toMatchObject({ kind: "user", status: "complete" });
        expect(received.at(-1)?.text).toBe("OpenRouter 本地完成。");
      }
    } finally { await mf.dispose(); mf = previous; }
  });

  it("discards Pi session records but not files or deduplication, and checkpoints deletion before delivery", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "new-history");
    try {
      const old = await telegram(1, "remember");
      expect((await waitJob(old.body.id)).status).toBe("complete");
      const memory = (await probe("/test/memory/file?path=MEMORY.md")).body;
      const skill = (await probe("/test/memory/file?path=skills/test/SKILL.md", "PUT", { content: "保留 Skill" })).body;
      const original = (await probe("/test/context")).body;
      expect(Object.values((await probe("/test/session")).body).every(count => Number(count) > 0)).toBe(true);
      const before = received.length;
      const calls = outbound.length;
      rejectOnce = true;
      const [queued, duplicate] = await Promise.all([telegram(2, "/new"), telegram(2, "/new")]);
      expect(queued.status).toBe(200);
      expect(duplicate.body.id).toBe(queued.body.id);
      let checkpoint;
      for (let i = 0; i < 100; i++) {
        checkpoint = (await probe(`/test/jobs/${queued.body.id}`)).body;
        if (checkpoint.retryAt) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(checkpoint).toMatchObject({ kind: "new", status: "ready", retryAt: expect.any(Number) });
      expect((await probe("/test/session")).body).toEqual({ record_ids: 0, conversations: 0, entries: 0, tasks: 0, submissions: 0, documents: 0, document_revisions: 0 });
      const empty = (await probe("/test/context")).body;
      expect(empty.context.messages).toEqual([]);
      expect(empty.entries).toEqual([]);
      expect(empty.provider.sessionId).not.toBe(original.provider.sessionId);
      const newView = (await probe("/test/context", "PUT", ["new-fact-after-reset-before-delivery"])).body;
      await mf.dispose();
      mf = await runtime("TestAgent", "new-history");
      expect(await waitJob(queued.body.id)).toMatchObject({ kind: "new", status: "complete", parts: checkpoint.parts });
      expect((await probe("/test/context")).body).toEqual(newView);
      expect(received.length).toBe(before + 1);
      expect(received.at(-1)).toMatchObject({ chat_id: 123, reply_parameters: { message_id: 3 } });
      const repeated = await telegram(2, "/new");
      expect((await waitJob(repeated.body.id)).status).toBe("complete");
      const oldReplay = await telegram(1, "remember");
      expect((await waitJob(oldReplay.body.id)).status).toBe("complete");
      expect(received.length).toBe(before + 1);
      expect((await probe("/test/context")).body).toEqual(newView);
      expect((await probe("/test/memory/file?path=MEMORY.md")).body).toEqual(memory);
      expect((await probe("/test/memory/file?path=skills/test/SKILL.md")).body).toEqual(skill);
      expect(outbound.slice(calls).every(host => host === "api.telegram.org")).toBe(true);
      const next = await telegram(3, "hello-after-new");
      expect((await waitJob(next.body.id)).status).toBe("complete");
      const view = (await probe("/test/context")).body;
      expect(JSON.stringify(view.context.messages)).toContain("hello-after-new");
      expect(JSON.stringify(view.entries)).not.toContain("remember");
      expect(JSON.stringify(view.entries)).not.toContain("/new");
    } finally { await mf.dispose(); mf = previous; }
  }, 10_000);

  it("rolls back a failed /new without losing the old session or files", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "new-failure");
    try {
      const original = (await probe("/test/context", "PUT", ["old-session-must-survive"])).body;
      const memory = (await probe("/test/memory/file?path=MEMORY.md", "PUT", { content: "保留记忆" })).body;
      const records = (await probe("/test/session", "PUT")).body;
      const queued = await telegram(1, "/new");
      const job = await waitJob(queued.body.id);
      expect(job).toMatchObject({ status: "failed", error: "session_reset_failed", parts: [expect.stringContaining("simulated discard failure")] });
      expect(received.at(-1)?.text).toBe(job.parts[0]);
      expect((await probe("/test/session")).body).toEqual(records);
      expect((await probe("/test/context")).body).toEqual(original);
      expect((await probe("/test/memory/file?path=MEMORY.md")).body).toEqual(memory);
      await probe("/test/session", "DELETE");
      const retried = await telegram(2, "/new");
      expect((await waitJob(retried.body.id)).status).toBe("complete");
      expect(Object.values((await probe("/test/session")).body).every(count => count === 0)).toBe(true);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("keeps messages after a queued /new out of the sleeping old conversation", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "new-steering");
    try {
      const event = { cron: "0 0 * * *", scheduledTime: new Date("2026-10-08T00:00:00Z") };
      const id = createHash("sha256").update(`cron:${event.cron}:${event.scheduledTime.getTime()}`).digest("hex");
      const before = received.length;
      expect((await (await mf.getWorker()).scheduled(event)).outcome).toBe("ok");
      for (let i = 0; i < 100 && received.length === before; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect((await probe(`/test/jobs/${id}`)).body.status).toBe("running");
      const queued = await telegram(1, "/new");
      const next = await telegram(2, "hello-after-new");
      expect((await waitJob(id)).status).toBe("complete");
      expect((await waitJob(queued.body.id)).status).toBe("complete");
      expect(await waitJob(next.body.id)).toMatchObject({ status: "complete", kind: "user" });
      const view = (await probe("/test/context")).body;
      expect(JSON.stringify(view.context.messages)).toContain("hello-after-new");
      expect(JSON.stringify(view.entries)).not.toContain("定时文字叫醒");
      expect(JSON.stringify(view.entries)).not.toContain("/new");
      expect(received.slice(before).map(message => message.text)).toEqual([...wakeupAssistant, "本地工具执行完成。", "已开始新会话，旧会话记录已丢弃；记忆和 Skill 文件已保留。", "本地测试回答。"]);
    } finally { await mf.dispose(); mf = previous; }
  }, 10_000);

  it("handles exact /retry without history and preserves Telegram access controls", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "retry-empty");
    try {
      expect((await telegram(1, "/retry", 456)).body.ignored).toBe(true);
      expect((await telegram(1, "/retry", 123, "wrong-secret")).status).toBe(401);
      const before = outbound.length;
      const queued = await telegram(1, " /retry\n");
      expect(await waitJob(queued.body.id)).toMatchObject({ kind: "retry", status: "complete", parts: ["当前没有可重试的用户消息。"] });
      expect(outbound.slice(before)).toEqual(["api.telegram.org"]);
      expect((await probe("/test/context")).body.context.messages).toEqual([]);
      for (const [index, input] of ["/retrying", "/retry extra"].entries()) {
        const normal = await telegram(index + 2, input);
        expect(await waitJob(normal.body.id)).toMatchObject({ kind: "user", status: "complete" });
      }
    } finally { await mf.dispose(); mf = previous; }
  });

  it("retries the original input, deletes its thinking/text/tool replies, and recovers without repeating cleanup", async () => {
    const previous = mf;
    const state = "retry-history";
    mf = await runtime("TestAgent", state);
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const earlier = await telegram(1, "earlier-turn");
      expect((await waitJob(earlier.body.id)).status).toBe("complete");
      const earlierIds = sentMessageIds.slice(-1);
      const messages = sentMessageIds.length;
      const source = await telegram(2, "intermediate-text");
      const sourceJob = await waitJob(source.body.id);
      const oldIds = sentMessageIds.slice(messages);
      expect(oldIds).toHaveLength(6);
      const before = (await probe("/test/context")).body;
      const input = before.entries.find((entry: any) => entry.kind === "pi.user");
      const [queued, duplicate] = await Promise.all([telegram(3, "/retry"), telegram(3, "/retry")]);
      expect(duplicate.body.id).toBe(queued.body.id);
      const retried = await waitJob(queued.body.id);
      expect(retried).toMatchObject({ kind: "retry", status: "complete", retry: { entry: input.id, replyTo: sourceJob.replyTo }, submissionId: expect.any(Number) });
      expect(deletedMessageIds).toEqual(new Set(oldIds));
      expect(earlierIds.every(id => !deletedMessageIds.has(id))).toBe(true);
      const after = (await probe("/test/context")).body;
      expect(after.entries.filter((entry: any) => entry.id <= input.id)).toEqual(before.entries.filter((entry: any) => entry.id <= input.id));
      for (const old of before.entries.filter((entry: any) => entry.id > input.id)) {
        const removed = after.entries.find((entry: any) => entry.id === old.id);
        expect(removed).toMatchObject({ id: old.id, kind: "telegram.discarded" });
        for (const field of ["model", "data", "edits", "head"]) expect(removed[field]).toBeUndefined();
      }
      expect(after.context.messages.filter((message: any) => message.role === "user" && message.content === "intermediate-text")).toHaveLength(1);
      expect(JSON.stringify(after.entries)).not.toContain("/retry");
      expect(received.at(-1)).toMatchObject({ reply_parameters: { message_id: sourceJob.replyTo } });
      const calls = telegramCalls.length;
      const sends = sentMessageIds.length;
      await mf.dispose(); mf = await runtime("TestAgent", state);
      await probe(`/test/jobs/${queued.body.id}`, "PUT");
      expect((await telegram(3, "/retry")).body.id).toBe(queued.body.id);
      expect((await waitJob(queued.body.id)).status).toBe("complete");
      expect(telegramCalls).toHaveLength(calls);
      expect(sentMessageIds).toHaveLength(sends);
      const again = await telegram(4, "/retry");
      expect(await waitJob(again.body.id)).toMatchObject({ status: "complete", retry: { entry: input.id, replyTo: sourceJob.replyTo } });
      expect(sentMessageIds.slice(messages, sends).every(id => deletedMessageIds.has(id))).toBe(true);
      expect(earlierIds.every(id => !deletedMessageIds.has(id))).toBe(true);
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  }, 15_000);

  it.each([false, true])("does not clear history or regenerate after a failed Telegram deletion (uncertain=%s)", async uncertain => {
    const previous = mf;
    mf = await runtime("TestAgent", `retry-delete-failure-${uncertain}`);
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const source = await telegram(1, "retry-source");
      expect((await waitJob(source.body.id)).status).toBe("complete");
      const before = (await probe("/test/context")).body;
      rejectDeleteOnce = !uncertain; ambiguousDeleteOnce = uncertain;
      const queued = await telegram(2, "/retry");
      const failed = await waitJob(queued.body.id);
      expect(failed).toMatchObject({ status: "failed", error: "retry_cleanup_failed" });
      expect(failed.retry).toBeUndefined(); expect(failed.submissionId).toBeUndefined();
      expect((await probe("/test/context")).body.context).toEqual(before.context);
      const repeated = await telegram(3, "/retry");
      expect((await waitJob(repeated.body.id)).status).toBe("complete");
    } finally { nextTelegramId = undefined; rejectDeleteOnce = false; ambiguousDeleteOnce = false; await mf.dispose(); mf = previous; }
  });

  it("removes a later compaction from retry context, preserves files, and cannot retry a discarded session", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "retry-compaction");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const memory = (await probe("/test/memory/file?path=MEMORY.md", "PUT", { content: "保留记忆" })).body;
      const earlier = await telegram(1, "earlier-turn"); await waitJob(earlier.body.id);
      const source = await telegram(2, "retry-source"); await waitJob(source.body.id);
      const before = (await probe("/test/context")).body;
      const input = before.entries.find((entry: any) => entry.kind === "pi.user");
      const compact = await telegram(3, "/compact");
      expect((await waitJob(compact.body.id)).status).toBe("complete");
      const retry = await telegram(4, "/retry");
      expect((await waitJob(retry.body.id)).status).toBe("complete");
      const after = (await probe("/test/context")).body;
      expect(after.context.head).toBeUndefined();
      expect(after.entries.filter((entry: any) => entry.id <= input.id)).toEqual(before.entries.filter((entry: any) => entry.id <= input.id));
      expect(JSON.stringify(after.context.messages)).not.toContain("测试压缩摘要");
      expect((await probe("/test/memory/file?path=MEMORY.md")).body).toEqual(memory);
      const reset = await telegram(5, "/new"); await waitJob(reset.body.id);
      const noHistory = await telegram(6, "/retry");
      expect(await waitJob(noHistory.body.id)).toMatchObject({ status: "complete", parts: ["当前没有可重试的用户消息。"] });
      expect((await probe("/test/context")).body.context.messages).toEqual([]);
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it("deletes a prior voice message and explicitly regenerates it for /retry", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "retry-speech");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const before = speechCalls;
      const source = await telegram(1, "speak");
      const original = await waitJob(source.body.id);
      expect(original.speech.status).toBe("sent");
      const retry = await telegram(2, "/retry");
      const result = await waitJob(retry.body.id);
      expect(result).toMatchObject({ status: "complete", speech: { status: "sent" } });
      expect(deletedMessageIds.has(original.speech.messageId)).toBe(true);
      expect(result.speech.messageId).not.toBe(original.speech.messageId);
      expect(deletedMessageIds.has(result.speech.messageId)).toBe(false);
      expect(voices.at(-1)?.replyTo).toBe(original.replyTo);
      expect(speechCalls).toBe(before + 2);
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it("rolls back history cleanup when its checkpoint fails, without regenerating", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "retry-checkpoint-failure");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const source = await telegram(1, "retry-source"); await waitJob(source.body.id);
      const before = (await probe("/test/context")).body;
      await probe("/test/session?retry", "PUT");
      const retry = await telegram(2, "/retry");
      const result = await waitJob(retry.body.id);
      expect(result).toMatchObject({ status: "failed", error: "retry_cleanup_failed" });
      expect(result.retry).toBeUndefined();
      expect(result.submissionId).toBeUndefined();
      expect((await probe("/test/context")).body.context).toEqual(before.context);
      await probe("/test/session?retry", "DELETE");
      const again = await telegram(3, "/retry");
      expect((await waitJob(again.body.id)).status).toBe("complete");
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it("retries the latest received input even if it failed before entering Pi history", async () => {
    const previous = mf;
    mf = await runtime("FailSecondAgent", "retry-unplaced-input");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const earlier = await telegram(1, "earlier-user-input");
      expect((await waitJob(earlier.body.id)).status).toBe("complete");
      const earlierId = sentMessageIds.at(-1)!;
      const source = await telegram(2, "latest-unplaced-input");
      expect(await waitJob(source.body.id)).toMatchObject({ status: "failed", parts: ["simulated model configuration failure"] });
      const oldErrorId = sentMessageIds.at(-1)!;
      const retry = await telegram(3, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete", retry: { input: "latest-unplaced-input" } });
      expect(deletedMessageIds.has(oldErrorId)).toBe(true);
      expect(deletedMessageIds.has(earlierId)).toBe(false);
      const again = await telegram(4, "/retry");
      expect((await waitJob(again.body.id)).status).toBe("complete");
      const context = (await probe("/test/context")).body.context.messages;
      expect(context.filter((message: any) => message.role === "user").map((message: any) => message.content)).toEqual(["earlier-user-input", "latest-unplaced-input"]);
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it.each(["length-text", "failed-text"])("cleans the previous %s reply before regenerating", async input => {
    const previous = mf;
    mf = await runtime("TestAgent", `retry-${input}`);
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const before = sentMessageIds.length;
      const source = await telegram(1, input); await waitJob(source.body.id);
      const oldIds = sentMessageIds.slice(before);
      const retry = await telegram(2, "/retry");
      const result = await waitJob(retry.body.id);
      expect(result.retry.entry).toEqual(expect.any(Number));
      expect(result.status).toBe(input === "length-text" ? "complete" : "failed");
      expect(oldIds.every(id => deletedMessageIds.has(id))).toBe(true);
      expect(sentMessageIds.length).toBeGreaterThan(before + oldIds.length);
      if (input === "length-text") expect(received.at(-2)?.text).toBe('(stopReason: "length")');
      const context = (await probe("/test/context")).body.context.messages;
      expect(context.filter((message: any) => message.role === "user" && message.content === input)).toHaveLength(1);
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it("does not regenerate an uncertain voice send whose message ID is unknown", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "retry-uncertain-speech");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      ambiguousVoiceOnce = true;
      const source = await telegram(1, "speak");
      expect(await waitJob(source.body.id)).toMatchObject({ speech: { status: "uncertain" } });
      const before = (await probe("/test/context")).body.context;
      const calls = speechCalls;
      const retry = await telegram(2, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "failed", error: "retry_cleanup_failed", parts: [expect.stringContaining("发送回执不完整")] });
      expect(speechCalls).toBe(calls);
      expect((await probe("/test/context")).body.context).toEqual(before);
    } finally { nextTelegramId = undefined; ambiguousVoiceOnce = false; await mf.dispose(); mf = previous; }
  });

  it("still retries the retained session after /new fails to clear it", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "retry-after-failed-new");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const source = await telegram(1, "retry-source"); await waitJob(source.body.id);
      await probe("/test/session", "PUT");
      const reset = await telegram(2, "/new");
      expect(await waitJob(reset.body.id)).toMatchObject({ status: "failed", error: "session_reset_failed" });
      await probe("/test/session", "DELETE");
      const retry = await telegram(3, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete", retry: { entry: expect.any(Number) } });
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it("keeps messages after queued /retry out of the original sleeping turn", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "retry-steering");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const count = received.length;
      const source = await telegram(1, "intermediate-text");
      await waitMessages(count + 4);
      const original = (await probe("/test/context")).body.entries.find((entry: any) => entry.kind === "pi.user");
      const retry = await telegram(2, "/retry");
      const next = await telegram(3, "later-user-input");
      expect((await waitJob(source.body.id)).status).toBe("complete");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete", retry: { entry: original.id } });
      expect((await waitJob(next.body.id)).status).toBe("complete");
      const context = (await probe("/test/context")).body.context.messages;
      expect(context.filter((message: any) => message.role === "user" && message.content === "later-user-input")).toHaveLength(1);
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  }, 10_000);

  it("runs Web Access through Pi Durable without external calls", async () => {
    const before = outbound.length;
    const queued = await telegram(48, "读取网页");
    expect(queued.status).toBe(200);
    const job = await waitJob(queued.body.id);
    expect(job.status).toBe("complete");
    expect(received.at(-1)?.text).toBe("本地工具执行完成。");
    expect(outbound.slice(before)).toContain("example.com");
    expect(outbound.slice(before)).toContain("cloudflare-dns.com");
  });

  it("calls Exa through Pi's web_search with the Worker Secret and normalized results", async () => {
    const before = outbound.length;
    const queued = await telegram(51, "exa-search");
    expect((await waitJob(queued.body.id)).status).toBe("complete");
    expect(outbound.slice(before)).toContain("api.exa.ai");
    expect(received.at(-1)?.text).toBe("本地工具执行完成。");
  });

  it("runs just-bash's built-in curl inside Workers with persistent downloads and no deployment Secrets", async () => {
    const before = outbound.length;
    const messages = received.length;
    const queued = await telegram(52, "curl-read");
    expect((await waitJob(queued.body.id)).status).toBe("complete");
    expect(outbound.slice(before)).toContain("cloudflare-dns.com");
    expect(outbound.slice(before)).toContain("example.com");
    expect((await probe("/test/memory/file?path=skills/curl/page.txt")).body.content).toBe("<title>Fixture</title><article><p>公开网页正文</p></article>");
    expect(received.at(-1)?.text).toBe("本地工具执行完成。");
    expect(received.slice(messages).some(message => message.text.includes("<title>Fixture</title>"))).toBe(false);
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

  it("retries a known Telegram 429 without re-running the bash memory write", async () => {
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

  it("forwards every assistant content type in order, without tool results or old history", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "assistant-text");
    try {
      await probe("/test/context", "POST", ["historical-assistant-must-not-send"]);
      const before = received.length;
      const callStart = telegramCalls.length;
      const queued = await telegram(1, "intermediate-text");
      await waitMessages(before + 4);
      expect(received.slice(before, before + 3).map(message => message.text)).toEqual(intermediateAssistant.slice(0, 3));
      expect(received[before + 3]?.rich_message.blocks[0]).toMatchObject({ type: "details" });
      expect((await probe(`/test/jobs/${queued.body.id}`)).body.status).toBe("running");
      expect((await waitJob(queued.body.id)).status).toBe("complete");
      expect(received.slice(before).map(message => message.text)).toEqual([...intermediateAssistant, ...finalAssistant]);
      const tools = telegramCalls.slice(callStart).filter(call => call.body.rich_message?.blocks);
      expect(tools.map(call => call.body.rich_message.blocks[0].summary[2].text)).toEqual(["requested", "running", "done"]);
      expect(tools.map(call => call.method)).toEqual(["sendRichMessage", "editMessageText", "editMessageText"]);
      const deliveries = (await probe("/test/deliveries")).body;
      expect(Object.values(deliveries).every((delivery: any) => delivery.status === "complete")).toBe(true);
      expect(Object.values(deliveries).filter((delivery: any) => delivery.presentation === "blocks")).toHaveLength(2);
      await mf.dispose();
      mf = await runtime("TestAgent", "assistant-text");
      const repeated = await telegram(1, "intermediate-text");
      expect((await waitJob(repeated.body.id)).status).toBe("complete");
      // Recover a generation checkpoint after delivery, before the job's final checkpoint.
      await probe(`/test/jobs/${queued.body.id}`, "PUT");
      await mf.dispose();
      mf = await runtime("TestAgent", "assistant-text");
      await telegram(1, "intermediate-text");
      expect((await waitJob(queued.body.id)).status).toBe("complete");
      expect((await probe("/test/deliveries")).body).toEqual(deliveries);
      expect(received.length).toBe(before + 6);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("deduplicates by assistant entry, not by text", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "assistant-repeated-text");
    try {
      const before = received.length;
      const queued = await telegram(1, "hello");
      expect((await waitJob(queued.body.id)).status).toBe("complete");
      const second = await telegram(2, "hello");
      expect((await waitJob(second.body.id)).status).toBe("complete");
      expect(received.slice(before).map(message => message.text)).toEqual(["本地测试回答。", "本地测试回答。"]);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("edits one persistent disclosure during real streamed thinking, then sends the public reply", async () => {
    const previous = mf;
    mf = await runtime("StreamingAgent", "streamed-thinking");
    try {
      const before = received.length;
      const calls = telegramCalls.length;
      const queued = await telegram(1, "stream thinking");
      for (let i = 0; i < 300 && received.length === before; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(received.length).toBe(before + 1);
      expect(received[before]?.parse_mode).toBe("HTML");
      expect((await probe(`/test/jobs/${queued.body.id}`)).body.status).toBe("running");
      expect((await waitJob(queued.body.id)).status).toBe("complete");
      expect(received.slice(before).map(message => message.text)).toEqual([`<blockquote expandable>${"流式思考。".repeat(96)}</blockquote>`, "流式完成。"]);
      const activity = telegramCalls.slice(calls);
      expect(activity.filter(call => call.method === "sendMessage")).toHaveLength(1);
      expect(activity.filter(call => call.method === "editMessageText").length).toBeGreaterThan(0);
      expect(activity.filter(call => call.method === "editMessageText").every(call => call.body.message_id === before + 1)).toBe(true);
      expect(activity.at(-1)).toMatchObject({ method: "sendRichMessage", body: { rich_message: { markdown: "流式完成。" } } });
    } finally { await mf.dispose(); mf = previous; }
  });

  it("stops after an uncertain tool-card edit without a fallback send or a duplicated final reply", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "uncertain-tool-edit");
    try {
      const before = received.length;
      ambiguousEditOnce = true;
      const queued = await telegram(1, "intermediate-text");
      expect(await waitJob(queued.body.id)).toMatchObject({ status: "failed", error: "telegram_delivery_uncertain" });
      expect(received.length).toBe(before + 4);
      expect(received.at(-1)?.text).toContain("bash: requested");
      await mf.dispose();
      mf = await runtime("TestAgent", "uncertain-tool-edit");
      await telegram(1, "intermediate-text");
      expect((await waitJob(queued.body.id)).error).toBe("telegram_delivery_uncertain");
      expect(received.length).toBe(before + 4);
    } finally { await mf.dispose(); mf = previous; ambiguousEditOnce = false; }
  });

  it("recovers an intermediate assistant text rate-limit retry before sending the final text", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "assistant-retry");
    try {
      const before = received.length;
      rejectOnce = true;
      const queued = await telegram(1, "intermediate-text");
      let retrying = false;
      for (let i = 0; i < 100; i++) {
        const deliveries: Record<string, { status: string; retryAt?: number }> = (await probe("/test/deliveries")).body;
        retrying = Object.values(deliveries).some(delivery => delivery.status === "ready" && (delivery.retryAt ?? 0) > Date.now());
        if (retrying) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(retrying).toBe(true);
      expect(received.length).toBe(before);
      await mf.dispose();
      mf = await runtime("TestAgent", "assistant-retry");
      await telegram(1, "intermediate-text");
      expect((await waitJob(queued.body.id)).status).toBe("complete");
      expect(received.slice(before).map(message => message.text)).toEqual([...intermediateAssistant.slice(0, 3), toolText("printf '工具输出不能发送'; printf '工具错误输出不能发送' >&2; sleep 1", "failed"), ...finalAssistant]);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("does not retry uncertain intermediate text or send a later final answer", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "assistant-uncertain");
    try {
      const before = received.length;
      ambiguousOnce = true;
      const queued = await telegram(1, "intermediate-text");
      expect(await waitJob(queued.body.id)).toMatchObject({ status: "failed", error: "telegram_delivery_uncertain" });
      expect(Object.values((await probe("/test/deliveries")).body).filter((delivery: any) => delivery.status === "failed")).toEqual([expect.objectContaining({ error: "telegram_delivery_uncertain" })]);
      await mf.dispose();
      mf = await runtime("TestAgent", "assistant-uncertain");
      await telegram(1, "intermediate-text");
      expect((await waitJob(queued.body.id)).error).toBe("telegram_delivery_uncertain");
      expect(received.length).toBe(before);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("does not resend an assistant part after a crash between sending and saving its receipt", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "assistant-intent-restart");
    try {
      const before = received.length;
      const queued = await telegram(1, "hello");
      expect((await waitJob(queued.body.id)).status).toBe("complete");
      await probe("/test/deliveries", "PUT");
      await probe(`/test/jobs/${queued.body.id}`, "PUT");
      await mf.dispose();
      mf = await runtime("TestAgent", "assistant-intent-restart");
      await telegram(1, "hello");
      expect(await waitJob(queued.body.id)).toMatchObject({ status: "failed", error: "telegram_delivery_uncertain" });
      expect(received.length).toBe(before + 1);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("forwards thinking-only, empty, failed and aborted assistant messages", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "assistant-empty");
    try {
      const before = received.length;
      const empty = await telegram(1, "thinking-only");
      expect((await waitJob(empty.body.id)).status).toBe("complete");
      expect(received.at(-1)?.text).toBe("<blockquote expandable>只有思考内容。</blockquote>");
      const noContent = await telegram(2, "empty-assistant");
      expect((await waitJob(noContent.body.id)).status).toBe("complete");
      expect(received.at(-1)?.text).toBe("（空回复）");
      const failed = await telegram(3, "failed-text");
      expect((await waitJob(failed.body.id)).error).toBe("agent_generation_failed");
      const aborted = await telegram(4, "aborted-text");
      expect((await waitJob(aborted.body.id)).error).toBe("agent_generation_failed");
      expect(received.slice(before).map(message => message.text)).toEqual([
        "<blockquote expandable>只有思考内容。</blockquote>", "（空回复）", "fixture failure", "Model response ended with stop reason aborted",
      ]);
      expect(Object.values((await probe("/test/deliveries")).body).filter((delivery: any) => delivery.presentation === "blocks")).toHaveLength(4);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("keeps already committed intermediate text when a later generation fails", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "assistant-later-failure");
    try {
      const before = received.length;
      rejectOnce = true;
      const queued = await telegram(1, "intermediate-text-then-fail");
      expect((await waitJob(queued.body.id)).error).toBe("agent_generation_failed");
      expect(received.slice(before).map(message => message.text)).toEqual([...intermediateAssistant.map(text => text.replace("; sleep 1", "")), "fixture failure"]);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("bounds and splits assistant text without breaking emoji", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "assistant-long");
    try {
      const before = received.length;
      const queued = await telegram(1, "long-text");
      expect((await waitJob(queued.body.id)).status).toBe("complete");
      const messages = received.slice(before).map(message => message.text);
      expect(messages.length).toBeGreaterThan(1);
      expect(messages.every(text => text.length <= 4000 && !/[\uD800-\uDBFF]$/.test(text))).toBe(true);
      expect(messages.join("")).toBe("中😀".repeat(6666) + "中");
    } finally { await mf.dispose(); mf = previous; }
  });

  it("reads the speech Skill on demand, uploads native multipart voice and deduplicates repeated model calls/updates", async () => {
    const before = voices.length;
    const generated = speechCalls;
    const messages = received.length;
    const queued = await telegram(46, "speak-twice");
    const job = await waitJob(queued.body.id);
    expect(job.status).toBe("complete");
    expect(job.speech).toMatchObject({ status: "sent", messageId: 10_000 + before + 1, bytes: 512 });
    expect(voices.at(-1)).toEqual({ chatId: "123", bytes: 512, replyTo: 47 });
    expect(voices.length).toBe(before + 1);
    expect(speechCalls).toBe(generated + 1);
    expect(received[messages]?.text).toBe(toolText("cat skills/telegram-speech/SKILL.md"));
    const skill = (await probe("/test/memory/file?path=skills/telegram-speech/SKILL.md")).body;
    expect(skill.content).toContain("# Telegram 语音");
    await mf.dispose();
    mf = await runtime();
    expect((await probe("/test/memory/file?path=skills/telegram-speech/SKILL.md")).body).toEqual(skill);
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
    expect(received.at(-1)?.text).toContain("不会自动重试");
    await mf.dispose();
    mf = await runtime();
    const duplicate = await telegram(47, "speak");
    expect((await waitJob(duplicate.body.id)).speech.status).toBe("uncertain");
    expect(voices.length).toBe(before);
    expect(speechCalls).toBe(generated + 1);
  });

  it("lets Pi send, sleep and receive an awake reply in one conversation", async () => {
    const previous = mf;
    const scheduled = await runtime("TestAgent", "scheduled");
    mf = scheduled;
    try {
      const worker = await scheduled.getWorker();
      const event = { cron: "0 0 * * *", scheduledTime: new Date("2026-10-08T00:00:00Z") };
      await probe("/test/context", "PUT", ["夜深了，提醒我早点睡觉。"]);
      const before = received.length;
      const generated = speechCalls;
      const voiceCount = voices.length;
      expect((await worker.scheduled(event)).outcome).toBe("ok");
      const id = createHash("sha256").update(`cron:${event.cron}:${event.scheduledTime.getTime()}`).digest("hex");
      await waitMessages(before + 2);
      expect(received.length).toBe(before + 2);
      expect(received[before]?.text).toContain("起床啦");
      expect((await probe(`/test/jobs/${id}`)).body).toMatchObject({ kind: "scheduled", status: "running" });
      expect(speechCalls).toBe(generated);
      expect(voices.length).toBe(voiceCount);
      expect((await worker.scheduled(event)).outcome).toBe("ok");
      expect(received.length).toBe(before + 2);
      const owner = await telegram(1001, "我醒了");
      const reminder = await waitJob(id);
      expect(reminder.status).toBe("complete");
      expect(reminder.speech).toBeUndefined();
      expect((await waitJob(owner.body.id)).status).toBe("complete");
      expect(received.length).toBe(before + 3);
      expect(received.at(-1)?.text).toBe("已停止提醒。");
      expect((await worker.scheduled(event)).outcome).toBe("ok");
      expect(received.length).toBe(before + 3);
      const context = (await probe("/test/context")).body.context;
      expect(JSON.stringify(context)).toContain("我醒了");
      expect(JSON.stringify(context)).toContain("起床啦，开始新的一天。");
      expect(JSON.stringify(context)).toContain("sleep 1");
    } finally { mf = previous; await scheduled.dispose(); }
  });

  it("resumes a sleeping Pi conversation after restart without replaying an intermediate send", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "sleep-restart");
    try {
      const event = { cron: "0 0 * * *", scheduledTime: new Date("2026-10-08T00:00:00Z") };
      const id = createHash("sha256").update(`cron:${event.cron}:${event.scheduledTime.getTime()}`).digest("hex");
      const before = received.length;
      expect((await (await mf.getWorker()).scheduled(event)).outcome).toBe("ok");
      await waitMessages(before + 2);
      expect(received.length).toBe(before + 2);
      expect((await probe(`/test/jobs/${id}`)).body.status).toBe("running");
      await mf.dispose();
      mf = await runtime("TestAgent", "sleep-restart");
      const owner = await telegram(1002, "我醒了");
      expect(await waitJob(id)).toMatchObject({ status: "complete" });
      expect((await waitJob(owner.body.id)).status).toBe("complete");
      expect(received.slice(before).map(message => message.text)).toEqual([wakeupAssistant[0], toolText("sleep 1", "failed"), "已停止提醒。"]);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("does not resume an expired job after restart", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "expired-job");
    try {
      const queued = await telegram(1, "hello");
      expect((await waitJob(queued.body.id)).status).toBe("complete");
      expect((await probe(`/test/jobs/${queued.body.id}?expired`, "PUT")).status).toBe(200);
      await mf.dispose();
      mf = await runtime("TestAgent", "expired-job");
      await telegram(1, "hello");
      expect(await waitJob(queued.body.id)).toMatchObject({ status: "failed", error: "agent_generation_failed" });
    } finally { await mf.dispose(); mf = previous; }
  });

  it("processes concurrently admitted distinct jobs without losing the alarm", async () => {
    const jobs = await Promise.all(Array.from({ length: 4 }, (_, index) => telegram(100 + index, `hello ${index}`)));
    expect(new Set(jobs.map((job) => job.body.id)).size).toBe(4);
    const done = await Promise.all(jobs.map((job) => waitJob(job.body.id)));
    expect(done.every((job) => job.status === "complete")).toBe(true);
    expect(new Set(done.map((job) => job.sequence)).size).toBe(4);
  });

  it("persists and reads nested Skill references through bash", async () => {
    const queued = await telegram(49, "persist-skill");
    expect((await waitJob(queued.body.id)).status).toBe("complete");
    expect((await probe("/test/memory/file?path=skills/test/nested/references/check.md")).body.content).toBe("持久化技能参考");
  });

  it("preserves history and forwards the configured model ID and medium reasoning without a catalog lookup", async () => {
    const fake = mf;
    const production = await runtime("ProbeAgent", "openrouter");
    mf = production;
    try {
      await probe("/test/context", "PUT", ["已有会话历史必须保留"]);
      await probe("/test/context", "POST", ["已有助手消息必须保留"]);
      await probe("/test/context", "PATCH", { identity: "legacy-removed-identity", web_safety: "legacy-removed-web_safety", telegram_speech: "legacy-removed-telegram_speech", current_time: "legacy-removed-current_time", hermes_memory: "legacy-removed-hermes_memory", bash: "legacy-removed-bash" });
      const before = outbound.length;
      const messages = received.length;
      const queued = await telegram(1, "只需回答一句话");
      const job = await waitJob(queued.body.id);
      expect(job.status).toBe("complete");
      expect(received.slice(messages).map(message => message.text)).toEqual(["<blockquote expandable>OpenRouter 可见思考。</blockquote>", "OpenRouter 本地完成。"]);
      expect(outbound.slice(before)).toContain("openrouter.ai");
      expect(JSON.stringify((await probe("/test/context")).body.context.messages)).toContain("已有会话历史必须保留");
    } finally { mf = fake; await production.dispose(); }
  });

  it("runs bash through Pi with shared files, no secrets, and persistence across restart", async () => {
    const before = (await probe("/test/memory/file?path=MEMORY.md")).body;
    const calls = outbound.length;
    const queued = await telegram(50, "bash-files");
    const job = await waitJob(queued.body.id);
    expect(job.status).toBe("complete");
    expect(received.at(-1)?.text).toBe("本地工具执行完成。");
    expect(outbound.slice(calls)).toEqual(Array(4).fill("api.telegram.org"));
    const memory = (await probe("/test/memory/file?path=MEMORY.md")).body;
    expect(memory.content).toContain("bash 追加记忆");
    expect(memory.etag).not.toBe(before.etag);
    await mf.dispose();
    mf = await runtime();
    expect((await probe("/test/memory/file?path=skills/bash/demo/SKILL.md")).body.content).toBe("持久化技能参考");
    expect((await probe("/test/memory/file?path=MEMORY.md")).body).toEqual(memory);
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

  it("stores a 256 KiB Unicode Skill and preserves its exact content and revision across restart", async () => {
    const content = "😀\n".repeat(50_000) + "x".repeat(MAX_FILE_BYTES - 250_000);
    const endpoint = "/test/memory/file?path=skills/large/reference.txt";
    const saved = await probe(endpoint, "PUT", { content });
    expect(saved.status).toBe(200);
    expect((await probe(endpoint)).body.content === content).toBe(true);
    await mf.dispose();
    mf = await runtime();
    const reread = await probe(endpoint);
    expect(reread.body.etag).toBe(saved.body.etag);
    expect(reread.body.content === content).toBe(true);
    expect((await probe(endpoint, "PUT", { content: content + "x" })).status).toBeGreaterThanOrEqual(400);
    expect((await probe(endpoint)).body).toEqual(saved.body);
  });
});
