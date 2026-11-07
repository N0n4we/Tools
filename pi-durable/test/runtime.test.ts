import { MAX_TELEGRAM_IMAGE_BYTES, stripTimePrefix } from "../src/telegram.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { MAX_FILE_BYTES } from "../src/memory/store.js";
import { MAX_VIDEO_BYTES, VIDEO_CHUNK_BYTES } from "../src/video/store.js";

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
const imageRequests: string[] = [];
const videoRequests: string[] = [];
const videoBytes = new Uint8Array(VIDEO_CHUNK_BYTES + 37);
const videoFixtureSizes: Record<string, number> = { "video-full-size": MAX_VIDEO_BYTES, "video-eight": 8 * 1024 * 1024, "video-seven": 7 * 1024 * 1024, "video-nine": 9 * 1024 * 1024 };
videoBytes.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52, 49]);
videoBytes[videoBytes.length - 1] = 255;
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=";
const pngBytes = Buffer.from(pngBase64, "base64");
const modelRequests: { model: string; messages: { role: string; content: unknown }[] }[] = [];
let rejectImageDownload = false;
let rejectVideoDownload = false;
const compactHistory = Array.from({ length: 6 }, (_, index) => `old-fact-${index}\n${"history ".repeat(4000)}`);
const toolText = (command: string, status = "done") => `bash: ${status}\n${JSON.stringify({ command }, null, 2)}`;
const intermediateAssistant = ["<blockquote expandable>中途思考内容。</blockquote>", "中途正文一。", "中途正文二。", toolText("printf '工具输出不能发送'; printf '工具错误输出不能发送' >&2; sleep 1")];
const finalAssistant = ["<blockquote expandable>最终思考内容。</blockquote>", "最终正文。"];
const longRunningAssistant = ["任务正在执行。", toolText("sleep 1")];
const popReply = "已弹出上一轮对话，用户消息及其后的回复已移除；记忆和 Skill 文件已保留。";
const startReply = "已恢复到最近一次 /compact 后的上下文，记忆和 Skill 文件已保留。";
let speechCalls = 0;
let ambiguousVoiceOnce = false;
let rejectOnce = false;
let ambiguousOnce = false;
let ambiguousEditOnce = false;
let stallModel = false;
let stalledModelStreams = 0;
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
      if (url.hostname === "api.telegram.org" && url.pathname === "/bottest-bot/getFile") {
        const { file_id } = await request.json() as { file_id: string };
        if (file_id.startsWith("video-")) {
          videoRequests.push(file_id);
          return Response.json({ ok: true, result: { file_path: `videos/${file_id}.mp4`, file_size: videoFixtureSizes[file_id] ?? videoBytes.length } });
        }
        imageRequests.push(file_id);
        return Response.json({ ok: true, result: { file_path: `photos/${file_id}.png`, file_size: file_id.startsWith("full-size") ? MAX_TELEGRAM_IMAGE_BYTES : pngBytes.length } });
      }
      if (url.hostname === "api.telegram.org" && url.pathname.startsWith("/file/bottest-bot/videos/")) {
        if (rejectVideoDownload) return new Response("failed", { status: 503 });
        if (url.pathname.endsWith("/video-invalid.mp4")) return new Response(pngBytes);
        const size = videoFixtureSizes[url.pathname.split("/").at(-1)!.replace(/\.mp4$/, "")];
        if (size !== undefined) {
          const bytes = new Uint8Array(size); bytes.set(videoBytes);
          return new Response(bytes);
        }
        return new Response(videoBytes, { headers: { "content-type": "application/octet-stream" } });
      }
      if (url.hostname === "api.telegram.org" && url.pathname.startsWith("/file/bottest-bot/photos/")) {
        if (rejectImageDownload) return new Response("failed", { status: 503 });
        if (/\/full-size(?:-[\w-]+)?\.png$/.test(url.pathname)) {
          const bytes = new Uint8Array(MAX_TELEGRAM_IMAGE_BYTES);
          bytes.set(pngBytes);
          return new Response(bytes);
        }
        return new Response(pngBytes, { headers: { "content-type": "application/octet-stream" } });
      }
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
        modelRequests.push(body);
        expect(body).toMatchObject({ model: "deepseek/deepseek-v4.1-flash-1017", stream: true, max_completion_tokens: 20_000, reasoning: { effort: "medium" } });
        expect(body).not.toHaveProperty("provider");
        const system = JSON.stringify(body.messages.filter(message => message.role === "system"));
        expect(system).not.toContain("legacy-removed-");
        expect(system).toContain("telegram-speech");
        for (const message of body.messages.filter(message => ["user", "assistant", "tool"].includes(message.role))) {
          const text = Array.isArray(message.content) ? message.content.filter(block => block.type === "text").map(block => block.text).join("") : message.content;
          expect(text).toEqual(expect.stringMatching(/^(?:\[\d{2}:\d{2}:\d{2}\]\n|\[\d{4}-\d{2}-\d{2} (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\]$)/));
        }
        const thinking = { id: "test-completion", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", reasoning: "OpenRouter 可见思考。" }, finish_reason: null }] };
        if (stallModel) {
          stalledModelStreams++;
          return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(thinking)}\n\n`)); },
          }), { headers: { "content-type": "text/event-stream" } });
        }
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

async function telegram(updateId: number, content: string | Record<string, unknown>, from = 123, secret = webhook) {
  if (nextTelegramId !== undefined && !incomingMessageIds.has(updateId)) incomingMessageIds.set(updateId, nextTelegramId++);
  const response = await mf.dispatchFetch("https://agent.invalid/telegram/webhook", {
    method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({ update_id: updateId, message: { message_id: nextTelegramId === undefined ? updateId + 1 : incomingMessageIds.get(updateId), from: { id: from }, chat: { id: 123, type: "private" }, ...(typeof content === "string" ? { text: content } : content) } }),
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
      ["POST", "/enqueue"], ["GET", "/memory/files"],
      ["GET", "/test/memory/file?path=MEMORY.md"], ["GET", `/test/jobs/${"a".repeat(64)}`],
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

  it("shows the last user input without model work or context changes and ignores control replies during retry cleanup", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "last-control");
    nextTelegramId = 400_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const before = modelRequests.length;
      const empty = await telegram(1, "/last");
      expect(await waitJob(empty.body.id)).toMatchObject({ status: "complete" });
      expect(received.at(-1)?.text).toBe("当前没有可展示的用户输入。");
      expect(modelRequests.slice(before)).toHaveLength(0);
      const original = "不要改写这条输入\n[12:34:56] 用户自己的时间";
      const source = await telegram(2, original); await waitJob(source.body.id);
      const saved = (await probe("/test/context")).body;
      const last = await telegram(3, " /last\n");
      const shown = await waitJob(last.body.id);
      expect(shown).toMatchObject({ kind: "last", status: "complete" });
      expect(received.at(-1)?.text).toBe(`上一次用户输入：\n${original}`);
      expect((await probe("/test/context")).body).toEqual(saved);
      expect(modelRequests.slice(before)).toHaveLength(1);
      const count = received.length;
      await telegram(3, " /last\n");
      expect(received).toHaveLength(count);
      const retry = await telegram(4, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete" });
      for (const id of shown.sentIds) expect(deletedMessageIds.has(id)).toBe(false);
      const after = await telegram(5, "/last"); await waitJob(after.body.id);
      expect(received.at(-1)?.text).toBe(`上一次用户输入：\n${original}`);
      const context = (await probe("/test/context")).body.context;
      expect(JSON.stringify(context)).not.toMatch(/上一次用户输入|\/last|当前没有可展示/);
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it("aborts a stalled OpenRouter stream immediately and retries the same user entry without control input in context", async () => {
    const previous = mf;
    mf = await runtime("AbortProbeAgent", "abort-openrouter");
    nextTelegramId = 410_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const before = modelRequests.length;
      const opened = stalledModelStreams;
      stallModel = true;
      const source = await telegram(1, "synthetic-stalled-input");
      for (let i = 0; i < 100 && stalledModelStreams === opened; i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(stalledModelStreams).toBe(opened + 1);
      const last = await telegram(2, "/last");
      expect(await waitJob(last.body.id)).toMatchObject({ status: "complete" });
      expect(received.at(-1)?.text).toBe("上一次用户输入：\nsynthetic-stalled-input");
      const abort = await telegram(3, "/abort");
      stallModel = false;
      const retry = await telegram(4, "/retry");
      const stopped = await waitJob(abort.body.id);
      expect(stopped).toMatchObject({ status: "complete", abortStopped: true });
      expect(await waitJob(source.body.id)).toMatchObject({ status: "failed", error: "user_aborted" });
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete" });
      expect((await probe("/test/model-http-abort")).body.aborted).toBe(true);
      expect(modelRequests.slice(before)).toHaveLength(2);
      const saved = (await probe("/test/context")).body.context.messages;
      const users = saved.filter((message: any) => message.role === "user");
      expect(users).toHaveLength(1);
      expect(stripTimePrefix(users[0].content)).toBe("synthetic-stalled-input");
      expect(JSON.stringify(saved)).not.toMatch(/\/abort|\/retry|\/last|已终止当前回复|上一次用户输入/);
      for (const id of stopped.sentIds) expect(deletedMessageIds.has(id)).toBe(false);
      const replay = await telegram(3, "/abort");
      expect(replay.body.id).toBe(abort.body.id);
      expect(modelRequests.slice(before)).toHaveLength(2);
    } finally { stallModel = false; nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it("aborts a sleeping tool and leaves the original input available for retry after restart", async () => {
    const previous = mf;
    const state = "abort-sleep";
    mf = await runtime("TestAgent", state);
    try {
      const before = received.length;
      const source = await telegram(1, "abort-sleep");
      await waitMessages(before + 2);
      const abort = await telegram(2, "/abort");
      expect(await waitJob(abort.body.id)).toMatchObject({ status: "complete", abortStopped: true });
      expect(await waitJob(source.body.id)).toMatchObject({ status: "failed", error: "user_aborted" });
      const count = received.length;
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(received).toHaveLength(count);
      await mf.dispose(); mf = await runtime("ProbeAgent", state);
      const last = await telegram(3, "/last"); await waitJob(last.body.id);
      expect(received.at(-1)?.text).toBe("上一次用户输入：\nabort-sleep");
      const retry = await telegram(4, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete" });
      const saved = (await probe("/test/context")).body.context.messages;
      expect(saved.filter((message: any) => message.role === "user")).toHaveLength(1);
      expect(JSON.stringify(saved)).not.toMatch(/\/abort|\/last|sleep 120|睡眠结束/);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("preserves queued user inputs on abort and does not replay an old abort against a later generation", async () => {
    const previous = mf;
    mf = await runtime("AbortProbeAgent", "abort-queued-inputs");
    try {
      const before = modelRequests.length;
      const opened = stalledModelStreams;
      stallModel = true;
      const source = await telegram(1, "synthetic initial input");
      for (let i = 0; i < 100 && stalledModelStreams === opened; i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(stalledModelStreams).toBe(opened + 1);
      const second = await telegram(2, "synthetic queued second input");
      const third = await telegram(3, "synthetic queued third input");
      for (const input of [second, third]) {
        let submitted = false;
        for (let i = 0; i < 100; i++) {
          submitted = (await probe(`/test/jobs/${input.body.id}`)).body.submissionId !== undefined;
          if (submitted) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(submitted).toBe(true);
      }
      const last = await telegram(4, "/last"); await waitJob(last.body.id);
      expect(received.at(-1)?.text).toBe("上一次用户输入：\nsynthetic queued third input");
      const abort = await telegram(5, "/abort");
      stallModel = false;
      const retry = await telegram(6, "/retry");
      expect(await waitJob(abort.body.id)).toMatchObject({ status: "complete", abortStopped: true });
      for (const input of [source, second, third]) expect(await waitJob(input.body.id)).toMatchObject({ status: "failed", error: "user_aborted" });
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete" });
      expect(modelRequests.slice(before)).toHaveLength(2);
      const context = (await probe("/test/context")).body.context.messages;
      expect(context.filter((message: any) => message.role === "user").map((message: any) => stripTimePrefix(message.content))).toEqual([
        "synthetic initial input", "synthetic queued second input", "synthetic queued third input",
      ]);
      expect(JSON.stringify(context)).not.toMatch(/\/last|\/abort|\/retry|已终止当前回复/);

      stallModel = true;
      const later = await telegram(7, "synthetic later generation");
      for (let i = 0; i < 100 && stalledModelStreams < opened + 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(stalledModelStreams).toBe(opened + 2);
      await telegram(5, "/abort");
      expect((await probe(`/test/jobs/${later.body.id}`)).body).toMatchObject({ status: "running" });
      const finalAbort = await telegram(8, "/abort");
      expect(await waitJob(finalAbort.body.id)).toMatchObject({ status: "complete", abortStopped: true });
    } finally { stallModel = false; await mf.dispose(); mf = previous; }
  });

  it("keeps an album intact when /last is interleaved and /abort arrives before collection completes", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "abort-collecting-album");
    try {
      const before = modelRequests.length;
      const first = await telegram(1, { video: { file_id: "video-abort-album" }, caption: "相册唯一说明", media_group_id: "abort-album" });
      const midway = await telegram(2, "/last"); await waitJob(midway.body.id);
      expect(received.at(-1)?.text).toBe("上一次用户输入：\n相册唯一说明\n[视频]");
      const second = await telegram(3, { photo: [{ file_id: "abort-album-image", width: 800, height: 600 }], media_group_id: "abort-album" });
      const last = await telegram(4, "/last"); await waitJob(last.body.id);
      expect(received.at(-1)?.text).toBe("上一次用户输入：\n相册唯一说明\n[视频]\n[图片]");
      const abort = await telegram(5, "/abort");
      expect(await waitJob(abort.body.id)).toMatchObject({ status: "complete", abortStopped: true });
      expect(await waitJob(first.body.id)).toMatchObject({ status: "failed", error: "user_aborted", imageBatch: [first.body.id, second.body.id] });
      expect(await waitJob(second.body.id)).toMatchObject({ status: "failed", error: "user_aborted", batchId: first.body.id });
      expect(modelRequests.slice(before)).toHaveLength(0);
      const stoppedLast = await telegram(6, "/last"); await waitJob(stoppedLast.body.id);
      expect(received.at(-1)?.text).toBe("上一次用户输入：\n相册唯一说明\n[视频]\n[图片]");
      const retry = await telegram(7, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete" });
      expect(modelRequests.slice(before)).toHaveLength(1);
      const blocks = modelRequests.at(-1)!.messages.filter(message => message.role === "user").flatMap(message => message.content as any[]);
      expect(blocks.map(block => block.type)).toEqual(["text", "text", "video_url", "image_url"]);
      expect(blocks[1].text).toBe("相册唯一说明");
    } finally { await mf.dispose(); mf = previous; }
  });

  it("submits albums with only the captions the user actually wrote, including media-only inputs", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "literal-media-captions");
    try {
      const before = modelRequests.length;
      const first = await telegram(1, { video: { file_id: "video-caption-first" }, caption: "这是我唯一的说明", media_group_id: "literal-captions" });
      const second = await telegram(2, { video: { file_id: "video-caption-second" }, media_group_id: "literal-captions" });
      for (const id of [first.body.id, second.body.id]) expect(await waitJob(id)).toMatchObject({ status: "complete" });
      expect(modelRequests.slice(before)).toHaveLength(1);
      const blocks = modelRequests.at(-1)!.messages.filter(message => message.role === "user").flatMap(message => message.content as any[]);
      expect(blocks.filter(block => block.type === "text").map(block => block.text)).toEqual([expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\]\n$/), "这是我唯一的说明"]);
      expect(blocks.filter(block => block.type === "video_url")).toHaveLength(2);
      const image = await telegram(3, { photo: [{ file_id: "no-caption", width: 800, height: 600 }] });
      expect(await waitJob(image.body.id)).toMatchObject({ status: "complete", input: "" });
      const latest = modelRequests.at(-1)!.messages.filter(message => message.role === "user").at(-1)!.content as any[];
      expect(latest.map(block => block.type)).toEqual(["text", "image_url"]);
      expect(latest[0].text).toMatch(/^\[\d{2}:\d{2}:\d{2}\]\n$/);
      const last = await telegram(4, "/last"); await waitJob(last.body.id);
      expect(received.at(-1)?.text).toBe("上一次用户输入：\n[图片]");
      const context = (await probe("/test/context")).body.context;
      expect(JSON.stringify(context)).not.toMatch(/请描述这张图片|请描述这个视频|\/last|上一次用户输入/);
    } finally { await mf.dispose(); mf = previous; }
  });

  it.each(["album", "burst"])("answers two consecutive photos in one model generation (%s)", async mode => {
    const previous = mf;
    mf = await runtime("ProbeAgent", `image-batch-${mode}`);
    try {
      const before = modelRequests.length;
      const messages = received.length;
      const photo = { photo: [{ file_id: "first", width: 800, height: 600 }], caption: "请比较这两张图片", ...(mode === "album" ? { media_group_id: "album-123" } : {}) };
      const first = await telegram(1, photo);
      await new Promise(resolve => setTimeout(resolve, 150));
      const second = await telegram(2, { ...photo, caption: "第二张", photo: [{ file_id: "second", width: 800, height: 600 }] });
      expect(await waitJob(first.body.id)).toMatchObject({ status: "complete" });
      expect(await waitJob(second.body.id)).toMatchObject({ status: "complete" });
      expect(modelRequests.slice(before)).toHaveLength(1);
      const users = modelRequests.at(-1)!.messages.filter(message => message.role === "user");
      const content = users.flatMap(message => message.content as any[]);
      expect(content.filter(block => block.type === "image_url")).toHaveLength(2);
      expect(content).toContainEqual({ type: "text", text: photo.caption });
      expect(content).toContainEqual({ type: "text", text: "第二张" });
      expect(received.slice(messages).filter(message => message.text === "OpenRouter 本地完成。")).toHaveLength(1);
    } finally { await mf.dispose(); mf = previous; }
  });

  it.each(["image-first", "video-first", "video-only"])("answers an album containing videos in a single generation (%s)", async order => {
    const previous = mf;
    mf = await runtime("ProbeAgent", `media-album-${order}`);
    try {
      const before = modelRequests.length;
      const messages = received.length;
      const image = { photo: [{ file_id: "album-photo", width: 800, height: 600 }], caption: "图片说明" };
      const video = { video: { file_id: "video-album" }, caption: "视频说明" };
      const media = order === "image-first" ? [image, video] : order === "video-first" ? [video, image] : [video, { video: { file_id: "video-album-second" }, caption: "第二段视频" }];
      const inputs = media.map(item => ({ ...item, media_group_id: "mixed-album" }));
      const first = await telegram(1, inputs[0]!);
      await new Promise(resolve => setTimeout(resolve, 150));
      const second = await telegram(2, inputs[1]!);
      const completed = [];
      for (const result of [first, second]) {
        const job = await waitJob(result.body.id);
        expect(job).toMatchObject({ status: "complete" });
        completed.push(job);
      }
      expect(completed[1].submissionId).toBe(completed[0].submissionId);
      expect(modelRequests.slice(before)).toHaveLength(1);
      const users = modelRequests.at(-1)!.messages.filter(message => message.role === "user");
      expect(users).toHaveLength(1);
      const blocks = users[0]!.content as any[];
      expect(blocks.filter(block => block.type !== "text").map(block => block.type)).toEqual(order === "image-first" ? ["image_url", "video_url"] : order === "video-first" ? ["video_url", "image_url"] : ["video_url", "video_url"]);
      expect(blocks.filter(block => block.type === "text").slice(1).map(block => block.text)).toEqual(media.map(item => item.caption));
      for (const block of blocks.filter(block => block.type === "video_url")) expect(Buffer.from(block.video_url.url.split(",")[1], "base64")).toEqual(Buffer.from(videoBytes));
      expect(received.slice(messages).filter(message => message.text === "OpenRouter 本地完成。")).toHaveLength(1);
      await Promise.all([telegram(1, inputs[0]!), telegram(2, inputs[1]!)]);
      expect(modelRequests.slice(before)).toHaveLength(1);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("recovers a video-first mixed album after restart and retries and pops the complete album", async () => {
    const previous = mf;
    const state = "mixed-album-restart";
    mf = await runtime("ProbeAgent", state);
    nextTelegramId = 200_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const before = modelRequests.length;
      const imageDownloads = imageRequests.length;
      const videoDownloads = videoRequests.length;
      const firstMedia = { video: { file_id: "video-mixed-restart" }, caption: "视频在前", media_group_id: "mixed-restart" };
      const secondMedia = { photo: [{ file_id: "mixed-restart-image", width: 800, height: 600 }], caption: "图片在后", media_group_id: "mixed-restart" };
      const first = await telegram(1, firstMedia);
      const second = await telegram(2, secondMedia);
      await mf.dispose(); mf = await runtime("ProbeAgent", state);
      await Promise.all([telegram(1, firstMedia), telegram(2, secondMedia)]);
      for (const id of [first.body.id, second.body.id]) expect(await waitJob(id)).toMatchObject({ status: "complete" });
      expect(modelRequests.slice(before)).toHaveLength(1);
      const saved = (await probe("/test/context")).body.context.messages.find((message: any) => message.role === "user");
      expect(saved.content.filter((block: any) => block.type !== "text").map((block: any) => block.type)).toEqual(["video", "image_ref"]);
      await probe(`/test/jobs/${first.body.id}`, "PUT");
      await mf.dispose(); mf = await runtime("ProbeAgent", state);
      rejectImageDownload = true; rejectVideoDownload = true;
      await telegram(1, firstMedia);
      expect(await waitJob(first.body.id)).toMatchObject({ status: "complete" });
      expect(modelRequests.slice(before)).toHaveLength(1);
      const retry = await telegram(3, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete" });
      expect(modelRequests.slice(before)).toHaveLength(2);
      const blocks = modelRequests.at(-1)!.messages.filter(message => message.role === "user").flatMap(message => message.content as any[]);
      expect(blocks.filter(block => block.type !== "text").map(block => block.type)).toEqual(["video_url", "image_url"]);
      expect((await probe("/test/context")).body.context.messages.filter((message: any) => message.role === "user")).toEqual([saved]);
      expect(imageRequests.slice(imageDownloads)).toEqual(["mixed-restart-image"]);
      expect(videoRequests.slice(videoDownloads)).toEqual(["video-mixed-restart"]);
      const pop = await telegram(4, "/pop");
      expect(await waitJob(pop.body.id)).toMatchObject({ status: "complete" });
      expect((await probe("/test/context")).body.context.messages.filter((message: any) => message.role !== "system")).toEqual([]);
      for (const updateId of [1, 2]) expect(deletedMessageIds.has(incomingMessageIds.get(updateId)!)).toBe(true);
      for (const id of [first.body.id, second.body.id]) expect((await probe(`/test/jobs/${id}`)).body.discarded).toBe(true);
    } finally { nextTelegramId = undefined; rejectImageDownload = false; rejectVideoDownload = false; await mf.dispose(); mf = previous; }
  });

  it("retries the whole mixed album if its video download fails before Pi admission", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "mixed-album-unplaced");
    try {
      const before = modelRequests.length;
      rejectVideoDownload = true;
      const first = await telegram(1, { photo: [{ file_id: "mixed-image", width: 800, height: 600 }], media_group_id: "mixed-failure" });
      const second = await telegram(2, { video: { file_id: "video-mixed-failure" }, media_group_id: "mixed-failure" });
      for (const id of [first.body.id, second.body.id]) expect(await waitJob(id)).toMatchObject({ status: "failed" });
      expect(modelRequests.slice(before)).toHaveLength(0);
      rejectVideoDownload = false;
      const retry = await telegram(3, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete" });
      expect(modelRequests.slice(before)).toHaveLength(1);
      const content = modelRequests.at(-1)!.messages.filter(message => message.role === "user").flatMap(message => message.content as any[]);
      expect(content.filter(block => block.type !== "text").map(block => block.type)).toEqual(["image_url", "video_url"]);
    } finally { rejectVideoDownload = false; await mf.dispose(); mf = previous; }
  });

  it("applies the 15 MiB video budget within a mixed album without removing its images", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "mixed-album-budget");
    try {
      const before = modelRequests.length;
      const media = [
        { video: { file_id: "video-eight" }, caption: "最早的视频" },
        { photo: [{ file_id: "mixed-budget-image", width: 800, height: 600 }], caption: "中间的图片" },
        { video: { file_id: "video-nine" }, caption: "最新的视频" },
      ];
      const queued = [];
      for (const [index, item] of media.entries()) queued.push(await telegram(index + 1, { ...item, media_group_id: "mixed-budget" }));
      for (const result of queued) expect(await waitJob(result.body.id)).toMatchObject({ status: "complete" });
      expect(modelRequests.slice(before)).toHaveLength(1);
      const blocks = modelRequests.at(-1)!.messages.filter(message => message.role === "user").flatMap(message => message.content as any[]);
      expect(blocks.filter(block => block.text === "[video omitted]")).toHaveLength(1);
      expect(blocks.filter(block => block.type === "image_url")).toHaveLength(1);
      expect(blocks.filter(block => block.type === "video_url")).toHaveLength(1);
      expect(Buffer.from(blocks.find(block => block.type === "video_url").video_url.url.split(",")[1], "base64")).toHaveLength(9 * 1024 * 1024);
      for (const item of media) expect(blocks).toContainEqual({ type: "text", text: item.caption });
    } finally { await mf.dispose(); mf = previous; }
  });

  it("steers an entire mixed album into a running conversation", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "mixed-album-steer");
    try {
      const before = received.length;
      const source = await telegram(1, "long-running-task");
      await waitMessages(before + 2);
      const first = await telegram(2, { video: { file_id: "video-mixed-steer" }, caption: "mixed-album-input", media_group_id: "mixed-steer" });
      const second = await telegram(3, { photo: [{ file_id: "mixed-steer-image", width: 800, height: 600 }], media_group_id: "mixed-steer" });
      for (const id of [source.body.id, first.body.id, second.body.id]) expect(await waitJob(id)).toMatchObject({ status: "complete" });
      expect(received.slice(before).filter(message => message.text === "已收到混合相册。")).toHaveLength(1);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("restores a collecting batch after restart, preserves both full-sized images on retry and pops the whole turn", async () => {
    const previous = mf;
    const state = "image-batch-restart";
    mf = await runtime("ProbeAgent", state);
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const before = modelRequests.length;
      const downloads = imageRequests.length;
      const firstPhoto = { photo: [{ file_id: "full-size-first", width: 1280, height: 960 }], caption: "一起比较两图", media_group_id: "album-restart" };
      const secondPhoto = { ...firstPhoto, photo: [{ file_id: "full-size-second", width: 1280, height: 960 }], caption: "第二张说明" };
      const first = await telegram(1, firstPhoto);
      const second = await telegram(2, secondPhoto);
      await mf.dispose(); mf = await runtime("ProbeAgent", state);
      const replay = await Promise.all([telegram(1, firstPhoto), telegram(2, secondPhoto)]);
      expect(replay.map(result => result.body.id)).toEqual([first.body.id, second.body.id]);
      for (const id of [first.body.id, second.body.id]) expect(await waitJob(id)).toMatchObject({ status: "complete" });
      expect(modelRequests.slice(before)).toHaveLength(1);
      const blocks = modelRequests.at(-1)!.messages.filter(message => message.role === "user").flatMap(message => message.content as any[]);
      const images = blocks.filter(block => block.type === "image_url");
      expect(images).toHaveLength(2);
      for (const image of images) expect(Buffer.from(image.image_url.url.split(",")[1], "base64")).toHaveLength(MAX_TELEGRAM_IMAGE_BYTES);
      const saved = (await probe("/test/context")).body.context.messages.find((message: any) => message.role === "user");
      expect(saved.content.filter((block: any) => block.type === "image_ref")).toHaveLength(2);
      expect(JSON.stringify(saved).length).toBeLessThan(2000);
      await probe(`/test/jobs/${first.body.id}`, "PUT");
      await mf.dispose(); mf = await runtime("ProbeAgent", state);
      rejectImageDownload = true;
      await telegram(1, firstPhoto);
      expect(await waitJob(first.body.id)).toMatchObject({ status: "complete" });
      expect(modelRequests.slice(before)).toHaveLength(1);
      const retry = await telegram(3, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete", retry: { entry: expect.any(Number) } });
      expect(modelRequests.slice(before)).toHaveLength(2);
      expect((await probe("/test/context")).body.context.messages.filter((message: any) => message.role === "user")).toEqual([saved]);
      expect(imageRequests.slice(downloads)).toEqual(["full-size-first", "full-size-second"]);
      const pop = await telegram(4, "/pop");
      expect(await waitJob(pop.body.id)).toMatchObject({ status: "complete" });
      expect((await probe("/test/context")).body.context.messages.filter((message: any) => message.role !== "system")).toEqual([]);
      for (const updateId of [1, 2]) expect(deletedMessageIds.has(incomingMessageIds.get(updateId)!)).toBe(true);
      for (const id of [first.body.id, second.body.id]) expect((await probe(`/test/jobs/${id}`)).body.discarded).toBe(true);
      expect((await telegram(2, secondPhoto)).body.id).toBe(second.body.id);
      expect(modelRequests.slice(before)).toHaveLength(2);
    } finally { nextTelegramId = undefined; rejectImageDownload = false; await mf.dispose(); mf = previous; }
  });

  it("retries both images when their batch fails before reaching Pi", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "image-batch-unplaced");
    try {
      const before = modelRequests.length;
      rejectImageDownload = true;
      const photo = { photo: [{ file_id: "first", width: 800, height: 600 }], caption: "比较两图" };
      const images = await Promise.all([telegram(1, photo), telegram(2, { ...photo, photo: [{ file_id: "second", width: 800, height: 600 }] })]);
      for (const image of images) expect(await waitJob(image.body.id)).toMatchObject({ status: "failed" });
      expect(modelRequests.slice(before)).toHaveLength(0);
      rejectImageDownload = false;
      const retry = await telegram(3, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete" });
      expect(modelRequests.slice(before)).toHaveLength(1);
      const blocks = modelRequests.at(-1)!.messages.filter(message => message.role === "user").flatMap(message => message.content as any[]);
      expect(blocks.filter(block => block.type === "image_url")).toHaveLength(2);
    } finally { rejectImageDownload = false; await mf.dispose(); mf = previous; }
  });

  it("keeps different albums separate and orders out-of-order album updates by message ID", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "image-albums");
    try {
      const before = modelRequests.length;
      const photo = { photo: [{ file_id: "image", width: 800, height: 600 }] };
      const results = [];
      for (const [id, album, caption] of [[2, "first", "第二张"], [1, "first", "第一张"], [3, "second", "另一个相册"]] as const) results.push(await telegram(id, { ...photo, media_group_id: album, caption }));
      for (const result of results) expect(await waitJob(result.body.id)).toMatchObject({ status: "complete" });
      expect(modelRequests.slice(before)).toHaveLength(2);
      const first = modelRequests[before]!.messages.filter(message => message.role === "user").flatMap(message => message.content as any[]);
      expect(first.filter(block => block.type === "text").slice(1).map(block => block.text)).toEqual(["第一张", "第二张"]);
      expect(first.filter(block => block.type === "image_url")).toHaveLength(2);
      expect((await telegram(2, { ...photo, media_group_id: "changed", caption: "第二张" })).status).toBe(409);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("delivers photos and image documents to the real provider as inline images, with owner checks and deduplication", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "image-provider");
    try {
      const downloads = imageRequests.length;
      const photo = { photo: [{ file_id: "small", width: 100, height: 100 }, { file_id: "large", width: 800, height: 600 }], caption: "图片里是什么？" };
      expect((await telegram(1, photo, 456)).body.ignored).toBe(true);
      expect((await telegram(1, photo, 123, "wrong-secret")).status).toBe(401);
      expect(imageRequests).toHaveLength(downloads);
      const [first, duplicate] = await Promise.all([telegram(1, photo), telegram(1, photo)]);
      expect(first.status).toBe(200);
      expect(duplicate.body.id).toBe(first.body.id);
      expect(await waitJob(first.body.id)).toMatchObject({ status: "complete", image: { fileId: "large" } });
      expect(imageRequests.slice(downloads)).toEqual(["large"]);
      const user = modelRequests.at(-1)?.messages.find(message => message.role === "user");
      expect(user?.content).toEqual([
        { type: "text", text: expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\]\n$/) },
        { type: "text", text: photo.caption },
        { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } },
      ]);
      expect(JSON.stringify(modelRequests.at(-1))).not.toContain("bottest-bot");
      expect((await telegram(1, { ...photo, photo: [{ file_id: "changed", width: 100, height: 100 }] })).status).toBe(409);
      const document = await telegram(2, { document: { file_id: "document", mime_type: "image/png" } });
      expect(await waitJob(document.body.id)).toMatchObject({ status: "complete", input: "" });
      expect(imageRequests.slice(downloads)).toEqual(["large", "document"]);
      const last = modelRequests.at(-1)?.messages.filter(message => message.role === "user").at(-1);
      expect((last?.content as any[]).filter(block => block.type === "text")).toEqual([{ type: "text", text: expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\]\n$/) }]);
      expect(last?.content).toContainEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } });
      const resetCaption = await telegram(3, { ...photo, caption: "/new" });
      expect(await waitJob(resetCaption.body.id)).toMatchObject({ status: "complete", kind: "user" });
    } finally { await mf.dispose(); mf = previous; }
  });

  it("persists a maximum-sized image and reuses its bytes on restart and /retry", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "image-restart");
    try {
      const downloads = imageRequests.length;
      const photo = { photo: [{ file_id: "full-size", width: 1280, height: 960, file_size: MAX_TELEGRAM_IMAGE_BYTES }], caption: "image-input" };
      const source = await telegram(1, photo);
      expect(await waitJob(source.body.id)).toMatchObject({ status: "complete" });
      const saved = (await probe("/test/context")).body.context.messages.find((message: any) => message.role === "user" && Array.isArray(message.content));
      expect(saved.content.at(-1)).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(Buffer.from(saved.content.at(-1).data, "base64")).toHaveLength(MAX_TELEGRAM_IMAGE_BYTES);
      await probe(`/test/jobs/${source.body.id}`, "PUT");
      await mf.dispose();
      mf = await runtime("TestAgent", "image-restart");
      rejectImageDownload = true;
      expect((await telegram(1, photo)).body.id).toBe(source.body.id);
      expect(await waitJob(source.body.id)).toMatchObject({ status: "complete" });
      const retry = await telegram(2, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete", retry: { entry: expect.any(Number) } });
      const after = (await probe("/test/context")).body.context.messages.filter((message: any) => message.role === "user" && Array.isArray(message.content));
      expect(after).toEqual([saved]);
      expect(imageRequests.slice(downloads)).toEqual(["full-size"]);
    } finally { rejectImageDownload = false; await mf.dispose(); mf = previous; }
  });

  it("retries an image whose first download failed before Pi could place the input", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "image-unplaced");
    try {
      rejectImageDownload = true;
      const source = await telegram(1, { document: { file_id: "unplaced", mime_type: "image/png" }, caption: "image-input" });
      expect(await waitJob(source.body.id)).toMatchObject({ status: "failed", error: "agent_generation_failed" });
      expect(received.at(-1)?.text).toBe("下载 Telegram 图片失败，请稍后重发。");
      rejectImageDownload = false;
      const retry = await telegram(2, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete", retry: { input: "image-input", image: { fileId: "unplaced" } } });
      expect(received.at(-1)?.text).toBe("已收到图片。");
    } finally { rejectImageDownload = false; await mf.dispose(); mf = previous; }
  });

  it("steers an image into an ongoing tool conversation", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "image-steer");
    try {
      const before = received.length;
      const source = await telegram(1, "intermediate-text");
      await waitMessages(before + 4);
      const image = await telegram(2, { photo: [{ file_id: "steered", width: 100, height: 100 }], caption: "image-input" });
      expect(await waitJob(source.body.id)).toMatchObject({ status: "complete" });
      expect(await waitJob(image.body.id)).toMatchObject({ status: "complete", submissionId: expect.any(Number) });
      expect(received.at(-1)?.text).toBe("已收到图片。");
    } finally { await mf.dispose(); mf = previous; }
  });

  it("reports an oversized image without aborting the ongoing conversation", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "image-steer-failure");
    try {
      const before = received.length;
      const source = await telegram(1, "intermediate-text");
      await waitMessages(before + 4);
      const image = await telegram(2, { document: { file_id: "oversized", mime_type: "image/png", file_size: MAX_TELEGRAM_IMAGE_BYTES + 1 } });
      expect(await waitJob(source.body.id)).toMatchObject({ status: "complete" });
      expect(await waitJob(image.body.id)).toMatchObject({ status: "failed", error: "agent_generation_failed" });
      expect(received.slice(before).some(message => message.text === "最终正文。")).toBe(true);
      expect(received.at(-1)?.text).toContain("图片超过 1 MiB");
    } finally { await mf.dispose(); mf = previous; }
  });

  it("receives consecutive maximum-sized photos during a tool call without overflowing Pi's inbox", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "image-steer-batch");
    try {
      const before = received.length;
      const source = await telegram(1, "long-running-task");
      await waitMessages(before + 2);
      const photo = { photo: [{ file_id: "full-size", width: 1280, height: 960, file_size: MAX_TELEGRAM_IMAGE_BYTES }], caption: "image-input" };
      const images = await Promise.all([telegram(2, photo), telegram(3, photo)]);
      expect(await waitJob(source.body.id)).toMatchObject({ status: "complete" });
      for (const image of images) expect(await waitJob(image.body.id)).toMatchObject({ status: "complete" });
      const users = (await probe("/test/context")).body.context.messages.filter((message: any) => message.role === "user" && Array.isArray(message.content));
      expect(users).toHaveLength(1);
      expect(users[0].content.filter((block: any) => block.type === "image_ref")).toHaveLength(2);
      expect(received.slice(before).filter(message => message.text === "已收到图片。")).toHaveLength(1);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("persists Telegram videos and sends their actual bytes to the provider as native video inputs", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "video-provider");
    try {
      const downloads = videoRequests.length;
      const media = { video: { file_id: "video-provider", file_size: videoBytes.length }, caption: "请说明视频中发生了什么" };
      expect((await telegram(1, media, 456)).body.ignored).toBe(true);
      expect((await telegram(1, media, 123, "wrong-secret")).status).toBe(401);
      expect(videoRequests).toHaveLength(downloads);
      const [source, duplicate] = await Promise.all([telegram(1, media), telegram(1, media)]);
      expect(duplicate.body.id).toBe(source.body.id);
      expect(await waitJob(source.body.id)).toMatchObject({ status: "complete", video: { fileId: "video-provider" } });
      expect(videoRequests.slice(downloads)).toEqual(["video-provider"]);
      const user = modelRequests.at(-1)!.messages.find(message => message.role === "user")!;
      const blocks = user.content as any[];
      expect(blocks.slice(0, 2)).toEqual([{ type: "text", text: expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\]\n$/) }, { type: "text", text: media.caption }]);
      expect(blocks[2].type).toBe("video_url");
      expect(blocks[2].video_url.url).toMatch(/^data:video\/mp4;base64,/);
      expect(Buffer.from(blocks[2].video_url.url.split(",")[1], "base64")).toEqual(Buffer.from(videoBytes));
      expect(JSON.stringify(modelRequests.at(-1))).not.toMatch(/bottest-bot|application\/x-pi-video/);
      const saved = (await probe("/test/context")).body;
      const attachment = saved.context.messages.find((message: any) => message.role === "user").content.at(-1);
      expect(attachment).toEqual({ type: "video", id: expect.stringMatching(/^[a-f0-9]{64}$/), mimeType: "video/mp4", size: videoBytes.length });
      expect(JSON.stringify(saved.entries).length).toBeLessThan(50_000);
      expect((await telegram(1, { ...media, video: { file_id: "video-changed" } })).status).toBe(409);
      const document = await telegram(2, { document: { file_id: "video-document", mime_type: "video/mp4" } });
      expect(await waitJob(document.body.id)).toMatchObject({ status: "complete", input: "" });
      const captionCommand = await telegram(3, { ...media, caption: "/pop" });
      expect(await waitJob(captionCommand.body.id)).toMatchObject({ status: "complete", kind: "user" });
      expect(videoRequests.slice(downloads)).toEqual(["video-provider", "video-document"]);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("admits new videos by omitting oldest video inputs above 15 MiB and keeps the policy after restart", async () => {
    const previous = mf;
    const state = "video-context-budget";
    mf = await runtime("ProbeAgent", state);
    try {
      const before = modelRequests.length;
      for (const [index, fileId] of ["video-eight", "video-seven", "video-nine"].entries()) {
        const queued = await telegram(index + 1, { video: { file_id: fileId }, caption: `视频 ${index + 1}` });
        expect(await waitJob(queued.body.id)).toMatchObject({ status: "complete" });
      }
      expect(modelRequests.slice(before)).toHaveLength(3);
      const exact = modelRequests[before + 1]!.messages.filter(message => message.role === "user").flatMap(message => message.content as any[]);
      expect(exact.filter(block => block.type === "video_url")).toHaveLength(2);
      expect(exact.some(block => block.text === "[video omitted]")).toBe(false);
      const newest = modelRequests.at(-1)!.messages.filter(message => message.role === "user").flatMap(message => message.content as any[]);
      expect(newest.filter(block => block.text === "[video omitted]")).toHaveLength(2);
      expect(newest.filter(block => block.type === "video_url")).toHaveLength(1);
      const bytes = Buffer.from(newest.find(block => block.type === "video_url").video_url.url.split(",")[1], "base64");
      expect(bytes).toHaveLength(9 * 1024 * 1024);
      for (const caption of ["视频 1", "视频 2", "视频 3"]) expect(newest).toContainEqual({ type: "text", text: caption });
      const saved = (await probe("/test/context")).body.context.messages.filter((message: any) => message.role === "user");
      expect(saved.map((message: any) => message.content.at(-1).size)).toEqual([8, 7, 9].map(size => size * 1024 * 1024));
      await mf.dispose(); mf = await runtime("ProbeAgent", state);
      rejectVideoDownload = true;
      const followup = await telegram(4, "继续分析最新视频");
      expect(await waitJob(followup.body.id)).toMatchObject({ status: "complete" });
      const after = modelRequests.at(-1)!.messages.filter(message => message.role === "user").flatMap(message => typeof message.content === "string" ? [] : message.content as any[]);
      expect(after.filter(block => block.text === "[video omitted]")).toHaveLength(2);
      expect(after.filter(block => block.type === "video_url")).toHaveLength(1);
    } finally { rejectVideoDownload = false; await mf.dispose(); mf = previous; }
  }, 15_000);

  it("stores a 20 MiB video in bounded SQLite chunks and retains it across restart, retry, pop and new sessions", async () => {
    const previous = mf;
    const state = "video-restart";
    mf = await runtime("ProbeAgent", state);
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const downloads = videoRequests.length;
      const media = { video: { file_id: "video-full-size", file_size: MAX_VIDEO_BYTES }, caption: "视频测试" };
      const source = await telegram(1, media);
      const original = await waitJob(source.body.id);
      expect(original.status, JSON.stringify(original)).toBe("complete");
      const wire = modelRequests.at(-1)!.messages.find(message => message.role === "user")!.content as any[];
      const transmitted = Buffer.from(wire.find(block => block.type === "video_url").video_url.url.split(",")[1], "base64");
      expect(transmitted).toHaveLength(MAX_VIDEO_BYTES);
      expect(transmitted.subarray(0, videoBytes.length)).toEqual(Buffer.from(videoBytes));
      const saved = (await probe("/test/context")).body.context.messages.find((message: any) => message.role === "user");
      expect(saved.content.at(-1)).toMatchObject({ type: "video", size: MAX_VIDEO_BYTES });
      const stored = (await probe("/test/videos")).body;
      expect(stored.videos).toHaveLength(1);
      expect(stored.chunks).toHaveLength(Math.ceil(MAX_VIDEO_BYTES / VIDEO_CHUNK_BYTES));
      expect(stored.chunks.every((chunk: any) => chunk.bytes <= VIDEO_CHUNK_BYTES)).toBe(true);
      expect(stored.chunks.reduce((size: number, chunk: any) => size + chunk.bytes, 0)).toBe(MAX_VIDEO_BYTES);
      await probe(`/test/jobs/${source.body.id}`, "PUT");
      await mf.dispose(); mf = await runtime("ProbeAgent", state);
      rejectVideoDownload = true;
      await telegram(1, media);
      expect((await waitJob(source.body.id)).status).toBe("complete");
      const retry = await telegram(2, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete", retry: { entry: expect.any(Number) } });
      const after = (await probe("/test/context")).body.context.messages.filter((message: any) => message.role === "user");
      expect(after).toEqual([saved]);
      const pop = await telegram(3, "/pop");
      expect((await waitJob(pop.body.id)).status).toBe("complete");
      expect((await probe("/test/context")).body.context.messages.filter((message: any) => message.role !== "system")).toEqual([]);
      expect((await probe("/test/archives")).body.some((file: any) => file.content.includes(saved.content.at(-1).id))).toBe(true);
      const reset = await telegram(4, "/new"); await waitJob(reset.body.id);
      expect((await probe("/test/videos")).body).toEqual(stored);
      const resend = await telegram(5, media);
      expect((await waitJob(resend.body.id)).status).toBe("complete");
      expect(videoRequests.slice(downloads)).toEqual(["video-full-size"]);
    } finally { nextTelegramId = undefined; rejectVideoDownload = false; await mf.dispose(); mf = previous; }
  }, 15_000);

  it("retries a video that failed before being placed in history", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "video-unplaced");
    try {
      rejectVideoDownload = true;
      const source = await telegram(1, { video: { file_id: "video-unplaced" }, caption: "重试视频" });
      expect(await waitJob(source.body.id)).toMatchObject({ status: "failed", parts: ["下载 Telegram 视频失败，请稍后重发。"] });
      expect((await probe("/test/videos")).body.videos).toEqual([]);
      rejectVideoDownload = false;
      const retry = await telegram(2, "/retry");
      const retried = await waitJob(retry.body.id);
      expect(retried, JSON.stringify(retried)).toMatchObject({ status: "complete", retry: { input: "重试视频", video: { fileId: "video-unplaced" } } });
      expect(received.at(-1)?.text).toBe("已收到视频。");
    } finally { rejectVideoDownload = false; await mf.dispose(); mf = previous; }
  });

  it("rolls back partial video chunks when persistence fails", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "video-storage-failure");
    try {
      await probe("/test/videos", "PUT");
      const source = await telegram(1, { video: { file_id: "video-rollback" } });
      expect((await waitJob(source.body.id)).status).toBe("failed");
      expect((await probe("/test/videos")).body).toEqual({ videos: [], chunks: [] });
      expect((await probe("/test/context")).body.context.messages.filter((message: any) => message.role !== "system")).toEqual([]);
      await probe("/test/videos", "DELETE");
      const retry = await telegram(2, "/retry");
      const retried = await waitJob(retry.body.id);
      expect(retried.status, JSON.stringify(retried)).toBe("complete");
    } finally { await mf.dispose(); mf = previous; }
  });

  it("steers videos into an active conversation and reports an oversized upload without aborting the run", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "video-steer");
    try {
      const before = received.length;
      const source = await telegram(1, "intermediate-text");
      await waitMessages(before + 4);
      const tooLarge = await telegram(2, { video: { file_id: "video-oversized", file_size: MAX_VIDEO_BYTES + 1 } });
      const video = await telegram(3, { video: { file_id: "video-steered" }, caption: "追加视频" });
      const original = await waitJob(source.body.id);
      expect(original.status, JSON.stringify(original)).toBe("complete");
      expect(await waitJob(tooLarge.body.id)).toMatchObject({ status: "failed", parts: [expect.stringContaining("20 MiB")] });
      expect((await waitJob(video.body.id)).status).toBe("complete");
      expect(received.slice(before).some(message => message.text === "已收到视频。")).toBe(true);
      expect((await probe("/test/context")).body.context.messages.some((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.type === "video"))).toBe(true);
    } finally { await mf.dispose(); mf = previous; }
  }, 10_000);

  it("rejects non-video bytes and mixed image/video inputs before adding them to history", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "video-invalid");
    try {
      expect(await probe("/enqueue", "POST", { requestId: "mixed-media", input: "mixed", image: { fileId: "image" }, video: { fileId: "video" } })).toMatchObject({ status: 400 });
      const source = await telegram(1, { video: { file_id: "video-invalid" } });
      expect(await waitJob(source.body.id)).toMatchObject({ status: "failed", parts: [expect.stringContaining("视频格式无效")] });
      expect((await probe("/test/videos")).body.videos).toEqual([]);
      expect((await probe("/test/context")).body.context.messages.filter((message: any) => message.role !== "system")).toEqual([]);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("rejects caller-supplied job kinds", async () => {
    for (const kind of ["scheduled", "user"]) {
      expect(await probe("/enqueue", "POST", { requestId: `removed-kind:${kind}`, input: "hello", kind })).toMatchObject({ status: 400, body: { error: "Invalid job kind" } });
    }
  });

  it("timestamps model messages in Beijing time across midnight in persisted history and archives without changing Telegram output", async () => {
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
      expect(messages.slice(0, 3)).toMatchObject([
        { role: "user", content: "[23:59:59]\n历史用户消息", timestamp: userTime },
        { role: "user", content: "[2027-01-01 Friday]", timestamp: assistantTime },
        { role: "assistant", content: [{ type: "text", text: "[00:00:00]\n" }, { type: "text", text: "历史助手消息" }], timestamp: assistantTime },
      ]);
      expect(received.slice(before).map(message => message.text)).toEqual([
        toolText("printf '测试用户喜欢简洁回答\\n' >> MEMORY.md; cat MEMORY.md"), "本地工具执行完成。",
      ]);
      const saved = (await probe("/test/context")).body;
      expect(saved.entries.some((entry: any) => entry.kind === "telegram.date")).toBe(true);
      await mf.dispose();
      mf = await runtime("TestAgent", "message-time");
      expect((await probe("/test/context")).body).toEqual(saved);
      const reset = await telegram(2, "/new");
      expect(await waitJob(reset.body.id)).toMatchObject({ status: "complete" });
      const archive = (await probe("/test/archives")).body;
      expect(JSON.parse(archive.map((file: any) => file.content).join(""))).toEqual(saved.entries.toReversed());
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
      const original = await probe("/test/context", "PUT", history);
      expect(original.status).toBe(200);
      const memory = (await probe("/test/memory/file?path=MEMORY.md", "PUT", { content: "保留长期记忆" })).body;
      const before = received.length;
      rejectOnce = true;
      const [queued, duplicate] = await Promise.all([telegram(1, "/compact"), telegram(1, "/compact")]);
      expect(queued.status).toBe(200);
      expect(duplicate.body.id).toBe(queued.body.id);
      const job = await waitJob(queued.body.id);
      expect(job).toMatchObject({ kind: "compact", status: "complete", parts: ["上下文已压缩，历史记录和记忆文件已保留。"] });
      const archive = (await probe("/test/archives")).body;
      expect(archive[0].path).toBe(`${job.archivePath}/context.json.part-000000`);
      expect(JSON.parse(archive.map((file: any) => file.content).join(""))).toEqual(original.body.entries.toReversed());
      expect(received.length).toBe(before + 1);
      expect(received.at(-1)).toMatchObject({ chat_id: 123, reply_parameters: { message_id: 2 } });
      const view = (await probe("/test/context")).body;
      expect(view.context.head).toMatchObject({ kind: "pi.compaction", data: { reason: "manual" } });
      expect(JSON.stringify(view.context.messages)).toContain("测试压缩摘要");
      expect(JSON.stringify(view.context.messages)).not.toContain("old-fact-0");
      expect(view.context.messages.at(-1).role).toBe("user");
      expect(stripTimePrefix(view.context.messages.at(-1).content)).toBe(history.at(-1));
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
      expect((await probe("/test/archives")).body).toEqual(archive);
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

  it("handles exact /start without a checkpoint or model call and preserves Telegram access controls", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "start-empty");
    try {
      expect((await telegram(1, "/start", 456)).body.ignored).toBe(true);
      expect((await telegram(1, "/start", 123, "wrong-secret")).status).toBe(401);
      const calls = outbound.length;
      const queued = await telegram(1, " /start\n");
      expect(await waitJob(queued.body.id)).toMatchObject({ kind: "start", status: "complete", start: {}, parts: ["尚无可恢复的压缩记录，请先执行 /compact 建立恢复点。"] });
      expect(outbound.slice(calls)).toEqual(["api.telegram.org"]);
      expect((await probe("/test/context")).body.context.messages).toEqual([]);
      for (const [index, input] of ["/starting", "/start extra"].entries()) {
        const normal = await telegram(index + 2, input);
        expect(await waitJob(normal.body.id)).toMatchObject({ kind: "user", status: "complete" });
      }
    } finally { await mf.dispose(); mf = previous; }
  });

  it("restores the exact compacted session, keeps current files, and never reruns old speech or tool tasks", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "start-history");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const earlier = await telegram(1, "retained-start-turn"); await waitJob(earlier.body.id);
      const source = await telegram(2, "speak"); const original = await waitJob(source.body.id);
      const compact = await telegram(3, "/compact");
      const compactJob = await waitJob(compact.body.id);
      expect(compactJob).toMatchObject({ status: "complete", compactCheckpoint: compact.body.id });
      const saved = (await probe("/test/context")).body;
      const counts = (await probe("/test/session")).body;
      const later = await telegram(4, "discarded-after-checkpoint"); await waitJob(later.body.id);
      const memory = (await probe("/test/memory/file?path=MEMORY.md", "PUT", { content: "恢复时保留当前记忆" })).body;
      const skill = (await probe("/test/memory/file?path=skills/current/SKILL.md", "PUT", { content: "恢复时保留当前技能" })).body;
      const calls = outbound.length;
      const speech = speechCalls;
      const start = await telegram(5, "/start");
      expect(await waitJob(start.body.id)).toMatchObject({ status: "complete", kind: "start", start: { checkpoint: compact.body.id }, parts: [startReply] });
      expect(outbound.slice(calls)).toEqual(["api.telegram.org"]);
      expect(speechCalls).toBe(speech);
      expect(deletedMessageIds.size).toBe(0);
      expect((await probe("/test/context")).body).toEqual(saved);
      expect((await probe("/test/session")).body).toEqual(counts);
      expect((await probe("/test/memory/file?path=MEMORY.md")).body).toEqual(memory);
      expect((await probe("/test/memory/file?path=skills/current/SKILL.md")).body).toEqual(skill);
      const retry = await telegram(6, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete", retry: { replyTo: original.replyTo } });
      expect(JSON.stringify((await probe("/test/context")).body.context.messages)).not.toContain("discarded-after-checkpoint");
      const pop = await telegram(7, "/pop"); await waitJob(pop.body.id);
      expect((await probe(`/test/jobs/${source.body.id}`)).body.discarded).toBe(true);
      const restoreAgain = await telegram(8, "/start");
      expect((await waitJob(restoreAgain.body.id)).status).toBe("complete");
      expect((await probe(`/test/jobs/${source.body.id}`)).body.discarded).toBe(false);
      expect((await probe("/test/context")).body).toEqual(saved);
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  }, 15_000);

  it("preserves a checkpoint across /new, skipped compaction and restarts, and restores without model configuration", async () => {
    const previous = mf;
    const state = "start-after-new";
    mf = await runtime("TestAgent", state);
    try {
      await probe("/test/context", "PUT", ["old-checkpoint-fact", "retained-checkpoint-fact"]);
      const compact = await telegram(1, "/compact"); await waitJob(compact.body.id);
      const saved = (await probe("/test/context")).body;
      const checkpoint = (await probe("/test/checkpoint")).body;
      const reset = await telegram(2, "/new"); await waitJob(reset.body.id);
      expect((await probe("/test/session")).body.entries).toBe(0);
      const skipped = await telegram(3, "/compact");
      expect(await waitJob(skipped.body.id)).toMatchObject({ status: "complete", parts: ["当前没有可压缩的历史内容。"] });
      expect((await probe("/test/checkpoint")).body).toEqual(checkpoint);
      await mf.dispose(); mf = await runtime("NoModelAgent", state);
      const calls = outbound.length;
      const start = await telegram(4, "/start");
      expect(await waitJob(start.body.id)).toMatchObject({ status: "complete", parts: [startReply] });
      expect(outbound.slice(calls)).toEqual(["api.telegram.org"]);
      await mf.dispose(); mf = await runtime("TestAgent", state);
      expect((await probe("/test/context")).body).toEqual(saved);
      const next = await telegram(5, "new-turn-after-start");
      expect((await waitJob(next.body.id)).status).toBe("complete");
      expect(JSON.stringify((await probe("/test/context")).body.context.messages)).toContain("new-turn-after-start");
    } finally { await mf.dispose(); mf = previous; }
  });

  it("deduplicates /start and does not restore again after restarting before confirmation delivery", async () => {
    const previous = mf;
    const state = "start-recovery";
    mf = await runtime("TestAgent", state);
    try {
      await probe("/test/context", "PUT", ["old-recovery-fact", "retained-recovery-fact"]);
      const compact = await telegram(1, "/compact"); await waitJob(compact.body.id);
      const later = await telegram(2, "remove-before-recovery"); await waitJob(later.body.id);
      rejectOnce = true;
      const [queued, duplicate] = await Promise.all([telegram(3, "/start"), telegram(3, "/start")]);
      expect(duplicate.body.id).toBe(queued.body.id);
      let checkpoint;
      for (let i = 0; i < 100; i++) {
        checkpoint = (await probe(`/test/jobs/${queued.body.id}`)).body;
        if (checkpoint.retryAt) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(checkpoint).toMatchObject({ kind: "start", status: "ready", start: { checkpoint: compact.body.id }, retryAt: expect.any(Number) });
      const nextView = (await probe("/test/context", "PUT", ["keep-after-restore-before-confirmation"])).body;
      const savedPoint = (await probe("/test/checkpoint")).body;
      await mf.dispose(); mf = await runtime("TestAgent", state);
      expect((await waitJob(queued.body.id)).status).toBe("complete");
      expect((await probe("/test/context")).body).toEqual(nextView);
      const calls = telegramCalls.length;
      await telegram(3, "/start");
      expect(telegramCalls).toHaveLength(calls);
      await probe(`/test/jobs/${queued.body.id}`, "PUT");
      await mf.dispose(); mf = await runtime("TestAgent", state);
      await telegram(3, "/start");
      expect((await waitJob(queued.body.id)).status).toBe("complete");
      expect((await probe("/test/context")).body).toEqual(nextView);
      expect((await probe("/test/checkpoint")).body).toEqual(savedPoint);
    } finally { rejectOnce = false; await mf.dispose(); mf = previous; }
  }, 10_000);

  it("replaces the restore point only after another successful manual compaction", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "start-latest");
    try {
      await probe("/test/context", "PUT", ["first-prefix", "first-retained"]);
      const first = await telegram(1, "/compact"); await waitJob(first.body.id);
      await probe("/test/context", "PUT", ["second-prefix", "second-retained"]);
      const second = await telegram(2, "/compact"); await waitJob(second.body.id);
      const saved = (await probe("/test/context")).body;
      const point = (await probe("/test/checkpoint")).body;
      expect(point.checkpoint.id).toBe(second.body.id);
      await probe("/test/context", "PUT", ["compaction-failure\nfailed-prefix", "failed-retained"]);
      const failed = await telegram(3, "/compact");
      expect((await waitJob(failed.body.id)).status).toBe("failed");
      expect((await probe("/test/checkpoint")).body).toEqual(point);
      const start = await telegram(4, "/start");
      expect((await waitJob(start.body.id)).status).toBe("complete");
      expect((await probe("/test/context")).body).toEqual(saved);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("rolls back a failed checkpoint save and retains the previous restore point", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "start-save-failure");
    try {
      await probe("/test/context", "PUT", ["original-prefix", "original-retained"]);
      const first = await telegram(1, "/compact"); await waitJob(first.body.id);
      const saved = (await probe("/test/context")).body;
      const point = (await probe("/test/checkpoint")).body;
      await probe("/test/context", "PUT", ["new-prefix", "new-retained"]);
      await probe("/test/checkpoint", "PUT");
      const second = await telegram(2, "/compact");
      expect(await waitJob(second.body.id)).toMatchObject({ status: "failed", parts: [expect.stringContaining("原有恢复点已保留")] });
      expect((await probe("/test/checkpoint")).body).toEqual(point);
      await probe("/test/checkpoint", "DELETE");
      const start = await telegram(3, "/start");
      expect((await waitJob(start.body.id)).status).toBe("complete");
      expect((await probe("/test/context")).body).toEqual(saved);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("rolls back a failed restore without changing the current context or losing the checkpoint", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "start-restore-failure");
    try {
      await probe("/test/context", "PUT", ["restore-prefix", "restore-retained"]);
      const compact = await telegram(1, "/compact"); await waitJob(compact.body.id);
      const saved = (await probe("/test/context")).body;
      const later = await telegram(2, "keep-if-restore-fails"); await waitJob(later.body.id);
      const before = (await probe("/test/context")).body;
      const point = (await probe("/test/checkpoint")).body;
      await probe("/test/session", "PUT");
      const start = await telegram(3, "/start");
      const failed = await waitJob(start.body.id);
      expect(failed).toMatchObject({ status: "failed", error: "session_restore_failed" });
      expect(failed.start).toBeUndefined();
      expect((await probe("/test/context")).body).toEqual(before);
      expect((await probe("/test/checkpoint")).body).toEqual(point);
      await probe("/test/session", "DELETE");
      const again = await telegram(4, "/start");
      expect((await waitJob(again.body.id)).status).toBe("complete");
      expect((await probe("/test/context")).body).toEqual(saved);
    } finally { await mf.dispose(); mf = previous; }
  });

  it.each(["image", "video"])("restores %s history after /new without downloading media again", async kind => {
    const previous = mf;
    mf = await runtime("TestAgent", `start-${kind}`);
    try {
      await probe("/test/context", "PUT", ["media-prefix", "media-fact"]);
      const source = await telegram(1, kind === "image"
        ? { photo: [{ file_id: "full-size", width: 1280, height: 960, file_size: MAX_TELEGRAM_IMAGE_BYTES }], caption: "image-input" }
        : { video: { file_id: "video-checkpoint" }, caption: "video-input" });
      expect((await waitJob(source.body.id)).status).toBe("complete");
      const compact = await telegram(2, "/compact");
      expect((await waitJob(compact.body.id)).status).toBe("complete");
      const saved = (await probe("/test/context")).body;
      expect(saved.entries.some((entry: any) => entry.model?.some((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.type === kind)))).toBe(true);
      const downloads = imageRequests.length + videoRequests.length;
      const reset = await telegram(3, "/new"); await waitJob(reset.body.id);
      rejectImageDownload = true; rejectVideoDownload = true;
      const start = await telegram(4, "/start");
      expect((await waitJob(start.body.id)).status).toBe("complete");
      expect((await probe("/test/context")).body).toEqual(saved);
      const retry = await telegram(5, "/retry");
      expect((await waitJob(retry.body.id)).status).toBe("complete");
      expect(imageRequests.length + videoRequests.length).toBe(downloads);
    } finally { rejectImageDownload = false; rejectVideoDownload = false; await mf.dispose(); mf = previous; }
  });

  it("adopts an existing post-compaction session before /new when upgrading without a saved checkpoint", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "start-existing");
    try {
      await probe("/test/context", "PUT", ["existing-prefix", "existing-retained"]);
      const compact = await telegram(1, "/compact"); await waitJob(compact.body.id);
      const saved = (await probe("/test/context")).body;
      await probe("/test/checkpoint?forget", "DELETE");
      const reset = await telegram(2, "/new");
      expect((await waitJob(reset.body.id)).status).toBe("complete");
      expect((await probe("/test/checkpoint")).body.checkpoint.id).toMatch(/^existing:/);
      const start = await telegram(3, "/start");
      expect((await waitJob(start.body.id)).status).toBe("complete");
      expect((await probe("/test/context")).body).toEqual(saved);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("queues /start behind active work and keeps the following message out of the discarded branch", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "start-steering");
    try {
      await probe("/test/context", "PUT", ["base-prefix", "base-retained"]);
      const compact = await telegram(1, "/compact"); await waitJob(compact.body.id);
      const count = received.length;
      const source = await telegram(2, "intermediate-text"); await waitMessages(count + 4);
      const start = await telegram(3, "/start");
      const next = await telegram(4, "input-after-start");
      expect((await waitJob(source.body.id)).status).toBe("complete");
      expect((await waitJob(start.body.id)).status).toBe("complete");
      expect((await waitJob(next.body.id)).status).toBe("complete");
      const context = (await probe("/test/context")).body.context;
      expect(JSON.stringify(context.messages)).toContain("base-retained");
      expect(JSON.stringify(context.messages)).toContain("input-after-start");
      expect(JSON.stringify(context.messages)).not.toContain("intermediate-text");
    } finally { await mf.dispose(); mf = previous; }
  }, 10_000);

  it("handles exact /new on a fresh session without a model call and keeps Telegram access controls", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "new-empty");
    try {
      expect((await telegram(1, "/new", 456)).body.ignored).toBe(true);
      expect((await telegram(1, "/new", 123, "wrong-secret")).status).toBe(401);
      const before = outbound.length;
      const queued = await telegram(1, " /new\n");
      const job = await waitJob(queued.body.id);
      expect(job).toMatchObject({ kind: "new", status: "complete", parts: ["已开始新会话，旧会话已归档；记忆和 Skill 文件已保留。"] });
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
      const archive = (await probe("/test/archives")).body;
      expect(archive[0].path).toBe(`${checkpoint.archivePath}/context.json.part-000000`);
      expect(JSON.parse(archive.map((file: any) => file.content).join(""))).toEqual(original.entries.toReversed());
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
      expect((await probe("/test/archives")).body).toEqual(archive);
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
      const before = received.length;
      const task = await telegram(1000, "long-running-task");
      const id = task.body.id;
      for (let i = 0; i < 100 && received.length === before; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect((await probe(`/test/jobs/${id}`)).body.status).toBe("running");
      const queued = await telegram(1, "/new");
      const next = await telegram(2, "hello-after-new");
      expect((await waitJob(id)).status).toBe("complete");
      expect((await waitJob(queued.body.id)).status).toBe("complete");
      expect(await waitJob(next.body.id)).toMatchObject({ status: "complete", kind: "user" });
      const view = (await probe("/test/context")).body;
      expect(JSON.stringify(view.context.messages)).toContain("hello-after-new");
      expect(JSON.stringify(view.entries)).not.toContain("long-running-task");
      expect(JSON.stringify(view.entries)).not.toContain("/new");
      expect(received.slice(before).map(message => message.text)).toEqual([...longRunningAssistant, "本地工具执行完成。", "已开始新会话，旧会话已归档；记忆和 Skill 文件已保留。", "本地测试回答。"]);
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
      const archive = (await probe("/test/archives")).body;
      expect(archive[0].path).toBe(`${retried.archivePath}/context.json.part-000000`);
      expect(JSON.parse(archive.map((file: any) => file.content).join(""))).toEqual(before.entries.toReversed());
      expect(deletedMessageIds).toEqual(new Set(oldIds));
      expect(earlierIds.every(id => !deletedMessageIds.has(id))).toBe(true);
      const after = (await probe("/test/context")).body;
      expect(after.entries.filter((entry: any) => entry.id <= input.id)).toEqual(before.entries.filter((entry: any) => entry.id <= input.id));
      for (const old of before.entries.filter((entry: any) => entry.id > input.id)) {
        const removed = after.entries.find((entry: any) => entry.id === old.id);
        expect(removed).toMatchObject({ id: old.id, kind: "telegram.discarded" });
        for (const field of ["model", "data", "edits", "head"]) expect(removed[field]).toBeUndefined();
      }
      expect(after.context.messages.filter((message: any) => message.role === "user" && stripTimePrefix(message.content) === "intermediate-text")).toHaveLength(1);
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
      expect((await probe("/test/archives")).body).toEqual(archive);
      const again = await telegram(4, "/retry");
      expect(await waitJob(again.body.id)).toMatchObject({ status: "complete", retry: { entry: input.id, replyTo: sourceJob.replyTo } });
      expect(sentMessageIds.slice(messages, sends).every(id => deletedMessageIds.has(id))).toBe(true);
      expect(earlierIds.every(id => !deletedMessageIds.has(id))).toBe(true);
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  }, 15_000);

  it.each(["compact", "new", "retry", "pop", "start"])("stops /%s before changing history or deleting replies if archiving fails", async command => {
    const previous = mf;
    mf = await runtime("TestAgent", `archive-failure-${command}`);
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const source = await telegram(1, "retry-source");
      expect((await waitJob(source.body.id)).status).toBe("complete");
      const original = (await probe("/test/context", "POST", ["中😀".repeat(60_000)])).body;
      expect((await probe("/test/archives", "PUT")).status).toBe(200);
      const queued = await telegram(2, `/${command}`);
      const failed = await waitJob(queued.body.id);
      expect(failed).toMatchObject({ status: "failed", parts: [expect.stringContaining(`历史上下文归档失败，未执行 /${command}`)] });
      expect(failed.archivePath).toBeUndefined();
      expect(failed.compactionTaskId).toBeUndefined();
      expect(failed.retry).toBeUndefined();
      expect(failed.pop).toBeUndefined();
      expect(failed.start).toBeUndefined();
      expect((await probe("/test/context")).body).toEqual(original);
      expect((await probe("/test/archives")).body).toEqual([]);
      expect(deletedMessageIds.size).toBe(0);
      await probe("/test/archives", "DELETE");
      const again = await telegram(3, `/${command}`);
      expect((await waitJob(again.body.id)).status).toBe("complete");
      const archive = (await probe("/test/archives")).body;
      expect(archive.length).toBeGreaterThan(1);
      expect(archive.every((file: any) => file.bytes <= MAX_FILE_BYTES)).toBe(true);
      expect(JSON.parse(archive.map((file: any) => file.content).join(""))).toEqual(original.entries.toReversed());
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

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
      expect(context.filter((message: any) => message.role === "user").map((message: any) => stripTimePrefix(message.content))).toEqual(["earlier-user-input", "latest-unplaced-input"]);
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
      expect(context.filter((message: any) => message.role === "user" && stripTimePrefix(message.content) === input)).toHaveLength(1);
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
      expect(context.filter((message: any) => message.role === "user" && stripTimePrefix(message.content) === "later-user-input")).toHaveLength(1);
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  }, 10_000);

  it("handles exact /pop without history, makes no model call, and preserves Telegram access controls", async () => {
    const previous = mf;
    mf = await runtime("ProbeAgent", "pop-empty");
    try {
      expect((await telegram(1, "/pop", 456)).body.ignored).toBe(true);
      expect((await telegram(1, "/pop", 123, "wrong-secret")).status).toBe(401);
      const calls = outbound.length;
      const queued = await telegram(1, " /pop\n");
      expect(await waitJob(queued.body.id)).toMatchObject({ kind: "pop", status: "complete", pop: {}, parts: ["当前没有可弹出的用户消息。"] });
      expect(outbound.slice(calls)).toEqual(["api.telegram.org"]);
      expect((await probe("/test/context")).body.context.messages).toEqual([]);
      for (const [index, input] of ["/popping", "/pop extra"].entries()) {
        const normal = await telegram(index + 2, input);
        expect(await waitJob(normal.body.id)).toMatchObject({ kind: "user", status: "complete" });
      }
    } finally { await mf.dispose(); mf = previous; }
  });

  it("pops the user and every reply, archives their history, preserves earlier context and files, and deduplicates updates", async () => {
    const previous = mf;
    const state = "pop-history";
    mf = await runtime("TestAgent", state);
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const memory = (await probe("/test/memory/file?path=MEMORY.md", "PUT", { content: "保留记忆" })).body;
      const skill = (await probe("/test/memory/file?path=skills/test/SKILL.md", "PUT", { content: "保留 Skill" })).body;
      const earlier = await telegram(1, "earlier-pop-turn"); await waitJob(earlier.body.id);
      const earlierId = sentMessageIds.at(-1)!;
      const messages = sentMessageIds.length;
      const source = await telegram(2, "intermediate-text");
      const original = await waitJob(source.body.id);
      const oldIds = sentMessageIds.slice(messages);
      expect(oldIds).toHaveLength(6);
      const before = (await probe("/test/context")).body;
      const input = before.entries.find((entry: any) => entry.kind === "pi.user");
      const calls = outbound.length;
      const [queued, duplicate] = await Promise.all([telegram(3, "/pop"), telegram(3, "/pop")]);
      expect(duplicate.body.id).toBe(queued.body.id);
      const popped = await waitJob(queued.body.id);
      expect(popped).toMatchObject({ kind: "pop", status: "complete", parts: [popReply], pop: { entry: input.id, replyTo: original.replyTo } });
      expect(popped.submissionId).toBeUndefined();
      expect(outbound.slice(calls).every(host => host === "api.telegram.org")).toBe(true);
      expect(deletedMessageIds).toEqual(new Set([original.replyTo, ...oldIds]));
      expect(deletedMessageIds.has(earlierId)).toBe(false);
      expect(deletedMessageIds.has(incomingMessageIds.get(1)!)).toBe(false);
      const archive = (await probe("/test/archives")).body;
      expect(archive[0].path).toBe(`${popped.archivePath}/context.json.part-000000`);
      expect(JSON.parse(archive.map((file: any) => file.content).join(""))).toEqual(before.entries.toReversed());
      const after = (await probe("/test/context")).body;
      expect(after.entries.filter((entry: any) => entry.id < input.id)).toEqual(before.entries.filter((entry: any) => entry.id < input.id));
      for (const old of before.entries.filter((entry: any) => entry.id >= input.id)) {
        const removed = after.entries.find((entry: any) => entry.id === old.id);
        expect(removed).toMatchObject({ id: old.id, kind: "telegram.discarded" });
        for (const field of ["model", "data", "edits", "head"]) expect(removed[field]).toBeUndefined();
      }
      expect(JSON.stringify(after.context.messages)).toContain("earlier-pop-turn");
      expect(JSON.stringify(after.context.messages)).not.toContain("intermediate-text");
      expect(JSON.stringify(after.entries)).not.toContain("/pop");
      expect((await probe("/test/memory/file?path=MEMORY.md")).body).toEqual(memory);
      expect((await probe("/test/memory/file?path=skills/test/SKILL.md")).body).toEqual(skill);
      expect((await probe(`/test/jobs/${source.body.id}`)).body.discarded).toBe(true);
      const requests = telegramCalls.length;
      await mf.dispose(); mf = await runtime("TestAgent", state);
      expect((await telegram(3, "/pop")).body.id).toBe(queued.body.id);
      expect((await telegram(2, "intermediate-text")).body.id).toBe(source.body.id);
      expect(telegramCalls).toHaveLength(requests);
      expect((await probe("/test/context")).body).toEqual(after);
      expect((await probe("/test/archives")).body).toEqual(archive);
      const next = await telegram(4, "new-input-after-pop");
      expect((await waitJob(next.body.id)).status).toBe("complete");
      const messagesAfter = (await probe("/test/context")).body.context.messages;
      expect(JSON.stringify(messagesAfter)).toContain("new-input-after-pop");
      expect(JSON.stringify(messagesAfter)).not.toContain("intermediate-text");
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  }, 15_000);

  it("pops consecutive turns and their retries without allowing /retry to resurrect a popped input", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "pop-retries");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const first = await telegram(1, "first-pop-turn"); const firstJob = await waitJob(first.body.id);
      const firstInput = (await probe("/test/context")).body.entries.find((entry: any) => entry.kind === "pi.user");
      const second = await telegram(2, "second-pop-turn"); await waitJob(second.body.id);
      const retry = await telegram(3, "/retry"); await waitJob(retry.body.id);
      const pop = await telegram(4, "/pop");
      expect(await waitJob(pop.body.id)).toMatchObject({ status: "complete", parts: [popReply] });
      for (const id of [second.body.id, retry.body.id]) expect((await probe(`/test/jobs/${id}`)).body.discarded).toBe(true);
      const retryEarlier = await telegram(5, "/retry");
      expect(await waitJob(retryEarlier.body.id)).toMatchObject({ status: "complete", retry: { entry: firstInput.id, replyTo: firstJob.replyTo } });
      const popEarlier = await telegram(6, "/pop");
      expect(await waitJob(popEarlier.body.id)).toMatchObject({ status: "complete", pop: { entry: firstInput.id, replyTo: firstJob.replyTo } });
      expect((await probe("/test/context")).body.context.messages.filter((message: any) => message.role !== "system")).toEqual([]);
      const empty = await telegram(7, "/pop");
      expect(await waitJob(empty.body.id)).toMatchObject({ status: "complete", parts: ["当前没有可弹出的用户消息。"] });
      const noRetry = await telegram(8, "/retry");
      expect(await waitJob(noRetry.body.id)).toMatchObject({ status: "complete", parts: ["当前没有可重试的用户消息。"] });
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it("does not pop another turn after a restart before confirmation delivery", async () => {
    const previous = mf;
    const state = "pop-recovery";
    mf = await runtime("TestAgent", state);
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const first = await telegram(1, "retained-before-restart"); await waitJob(first.body.id);
      const second = await telegram(2, "popped-before-restart"); await waitJob(second.body.id);
      rejectOnce = true;
      const queued = await telegram(3, "/pop");
      let checkpoint;
      for (let i = 0; i < 100; i++) {
        checkpoint = (await probe(`/test/jobs/${queued.body.id}`)).body;
        if (checkpoint.retryAt) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(checkpoint).toMatchObject({ kind: "pop", status: "ready", pop: { entry: expect.any(Number) }, retryAt: expect.any(Number) });
      const calls = telegramCalls.filter(call => call.method === "deleteMessages").length;
      const archive = (await probe("/test/archives")).body;
      const view = (await probe("/test/context", "PUT", ["new-fact-before-pop-confirmation"])).body;
      await mf.dispose(); mf = await runtime("TestAgent", state);
      expect(await waitJob(queued.body.id)).toMatchObject({ status: "complete", parts: [popReply] });
      expect((await probe("/test/context")).body).toEqual(view);
      expect(telegramCalls.filter(call => call.method === "deleteMessages")).toHaveLength(calls);
      expect((await probe("/test/archives")).body).toEqual(archive);
    } finally { nextTelegramId = undefined; rejectOnce = false; await mf.dispose(); mf = previous; }
  }, 10_000);

  it.each([false, true])("preserves context if Telegram deletion fails and does not retry a duplicate update (uncertain=%s)", async uncertain => {
    const previous = mf;
    mf = await runtime("TestAgent", `pop-delete-failure-${uncertain}`);
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const source = await telegram(1, "pop-delete-source"); await waitJob(source.body.id);
      const before = (await probe("/test/context")).body;
      rejectDeleteOnce = !uncertain; ambiguousDeleteOnce = uncertain;
      const queued = await telegram(2, "/pop");
      expect(await waitJob(queued.body.id)).toMatchObject({ status: "failed", error: "pop_cleanup_failed", parts: [expect.stringContaining("历史未移除")] });
      expect((await probe("/test/context")).body.context).toEqual(before.context);
      expect((await probe(`/test/jobs/${source.body.id}`)).body.discarded).toBeUndefined();
      const calls = telegramCalls.length;
      await telegram(2, "/pop");
      expect(telegramCalls).toHaveLength(calls);
      const again = await telegram(3, "/pop");
      expect((await waitJob(again.body.id)).status).toBe("complete");
    } finally { nextTelegramId = undefined; rejectDeleteOnce = false; ambiguousDeleteOnce = false; await mf.dispose(); mf = previous; }
  });

  it("rolls back a failed pop checkpoint together with history and source markers", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "pop-checkpoint-failure");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const source = await telegram(1, "pop-checkpoint-source"); await waitJob(source.body.id);
      const before = (await probe("/test/context")).body;
      await probe("/test/session?retry", "PUT");
      const queued = await telegram(2, "/pop");
      const failed = await waitJob(queued.body.id);
      expect(failed).toMatchObject({ status: "failed", error: "pop_cleanup_failed" });
      expect(failed.pop).toBeUndefined();
      expect((await probe("/test/context")).body.context).toEqual(before.context);
      expect((await probe(`/test/jobs/${source.body.id}`)).body.discarded).toBeUndefined();
      await probe("/test/session?retry", "DELETE");
      const again = await telegram(3, "/pop");
      expect((await waitJob(again.body.id)).status).toBe("complete");
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it("pops a failed input that never entered Pi history and leaves earlier context available to /retry", async () => {
    const previous = mf;
    mf = await runtime("FailSecondAgent", "pop-unplaced");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const earlier = await telegram(1, "retained-before-failure"); const earlierJob = await waitJob(earlier.body.id);
      const latest = await telegram(2, "unplaced-pop-input");
      const latestJob = await waitJob(latest.body.id);
      expect(latestJob).toMatchObject({ status: "failed", parts: ["simulated model configuration failure"] });
      const before = (await probe("/test/context")).body;
      const errorMessage = sentMessageIds.at(-1)!;
      const pop = await telegram(3, "/pop");
      expect(await waitJob(pop.body.id)).toMatchObject({ status: "complete", pop: { replyTo: latestJob.replyTo } });
      expect(deletedMessageIds.has(latestJob.replyTo)).toBe(true);
      expect(deletedMessageIds.has(errorMessage)).toBe(true);
      expect((await probe("/test/context")).body.context).toEqual(before.context);
      const retry = await telegram(4, "/retry");
      expect(await waitJob(retry.body.id)).toMatchObject({ status: "complete", retry: { replyTo: earlierJob.replyTo } });
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it("keeps an image caption /pop as user input, then removes that image turn without downloading it again", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "pop-image");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const source = await telegram(1, { photo: [{ file_id: "pop-photo", file_unique_id: "pop-photo", width: 1, height: 1, file_size: pngBytes.length }], caption: "/pop" });
      const original = await waitJob(source.body.id);
      expect(original).toMatchObject({ kind: "user", status: "complete" });
      const input = (await probe("/test/context")).body.entries.find((entry: any) => entry.kind === "pi.user");
      expect(JSON.stringify(input)).toContain(pngBase64);
      const downloads = imageRequests.length;
      const pop = await telegram(2, "/pop");
      expect(await waitJob(pop.body.id)).toMatchObject({ status: "complete", pop: { entry: input.id } });
      expect(imageRequests).toHaveLength(downloads);
      const view = (await probe("/test/context")).body;
      expect(JSON.stringify(view.entries)).not.toContain(pngBase64);
      expect(view.context.messages.filter((message: any) => message.role !== "system")).toEqual([]);
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it("pops a placed input without consulting a failing model configuration", async () => {
    const previous = mf;
    mf = await runtime("FailSecondAgent", "pop-without-model");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const source = await telegram(1, "pop-without-model"); const original = await waitJob(source.body.id);
      expect(original.status).toBe("complete");
      const pop = await telegram(2, "/pop");
      expect(await waitJob(pop.body.id)).toMatchObject({ status: "complete", pop: { entry: expect.any(Number), replyTo: original.replyTo } });
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it("removes later compaction and the popped input's date separator while preserving earlier history", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "pop-compaction");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const timestamp = Date.UTC(2026, 9, 20, 12);
      await probe(`/test/context?timestamp=${timestamp}`, "PUT", compactHistory);
      const source = await telegram(1, "pop-compacted-input"); await waitJob(source.body.id);
      const before = (await probe("/test/context")).body;
      expect(before.entries.some((entry: any) => entry.kind === "telegram.date")).toBe(true);
      const compact = await telegram(2, "/compact");
      expect((await waitJob(compact.body.id)).status).toBe("complete");
      const pop = await telegram(3, "/pop");
      expect((await waitJob(pop.body.id)).status).toBe("complete");
      const after = (await probe("/test/context")).body;
      expect(after.context.head).toBeUndefined();
      expect(after.entries.some((entry: any) => entry.kind === "telegram.date")).toBe(false);
      expect(after.context.messages.filter((message: any) => message.role === "user").map((message: any) => stripTimePrefix(message.content))).toEqual(compactHistory);
      expect(JSON.stringify(after.context.messages)).not.toContain("测试压缩摘要");
      const next = await telegram(4, "next-after-popped-date");
      expect((await waitJob(next.body.id)).status).toBe("complete");
      const reset = await telegram(5, "/new"); await waitJob(reset.body.id);
      const empty = await telegram(6, "/pop");
      expect(await waitJob(empty.body.id)).toMatchObject({ status: "complete", parts: ["当前没有可弹出的用户消息。"] });
    } finally { nextTelegramId = undefined; await mf.dispose(); mf = previous; }
  });

  it("queues /pop behind a running turn and keeps following input out of the turn being popped", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "pop-steering");
    nextTelegramId = 100_000; incomingMessageIds.clear(); deletedMessageIds.clear();
    try {
      const count = received.length;
      const source = await telegram(1, "intermediate-text");
      await waitMessages(count + 4);
      const pop = await telegram(2, "/pop");
      const next = await telegram(3, "input-after-queued-pop");
      expect((await waitJob(source.body.id)).status).toBe("complete");
      expect((await waitJob(pop.body.id)).status).toBe("complete");
      expect((await waitJob(next.body.id)).status).toBe("complete");
      const view = (await probe("/test/context")).body;
      expect(view.context.messages.filter((message: any) => message.role === "user").map((message: any) => stripTimePrefix(message.content))).toEqual(["input-after-queued-pop"]);
      expect(deletedMessageIds.has(incomingMessageIds.get(3)!)).toBe(false);
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

  it("lets a user task send, sleep and receive a steering reply in one conversation", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "user-long-running");
    try {
      const before = received.length;
      const generated = speechCalls;
      const voiceCount = voices.length;
      const task = await telegram(1000, "long-running-task");
      const id = task.body.id;
      await waitMessages(before + 2);
      expect(received.length).toBe(before + 2);
      expect(received[before]?.text).toBe("任务正在执行。");
      expect((await probe(`/test/jobs/${id}`)).body).toMatchObject({ kind: "user", status: "running" });
      expect(speechCalls).toBe(generated);
      expect(voices.length).toBe(voiceCount);
      expect((await telegram(1000, "long-running-task")).body.id).toBe(id);
      expect(received.length).toBe(before + 2);
      const owner = await telegram(1001, "finish-task");
      const completed = await waitJob(id);
      expect(completed.status).toBe("complete");
      expect(completed.speech).toBeUndefined();
      expect((await waitJob(owner.body.id)).status).toBe("complete");
      expect(received.length).toBe(before + 3);
      expect(received.at(-1)?.text).toBe("任务已结束。");
      expect((await telegram(1000, "long-running-task")).body.id).toBe(id);
      expect(received.length).toBe(before + 3);
      const context = (await probe("/test/context")).body.context;
      expect(JSON.stringify(context)).toContain("finish-task");
      expect(JSON.stringify(context)).toContain("任务正在执行。");
      expect(JSON.stringify(context)).toContain("sleep 1");
    } finally { await mf.dispose(); mf = previous; }
  });

  it("resumes a sleeping Pi conversation after restart without replaying an intermediate send", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "sleep-restart");
    try {
      const before = received.length;
      const task = await telegram(1000, "long-running-task");
      const id = task.body.id;
      await waitMessages(before + 2);
      expect(received.length).toBe(before + 2);
      expect((await probe(`/test/jobs/${id}`)).body.status).toBe("running");
      await mf.dispose();
      mf = await runtime("TestAgent", "sleep-restart");
      const owner = await telegram(1002, "finish-task");
      expect(await waitJob(id)).toMatchObject({ status: "complete" });
      expect((await waitJob(owner.body.id)).status).toBe("complete");
      expect(received.slice(before).map(message => message.text)).toEqual([longRunningAssistant[0], toolText("sleep 1", "failed"), "任务已结束。"]);
    } finally { await mf.dispose(); mf = previous; }
  });

  it("stops a persisted job from a removed feature before accepting more user input", async () => {
    const previous = mf;
    mf = await runtime("TestAgent", "removed-job");
    try {
      const before = received.length;
      const task = await telegram(1000, "long-running-task");
      await waitMessages(before + 2);
      const initialMessages = received.slice(before).map(message => message.text);
      expect((await probe(`/test/jobs/${task.body.id}?kind=scheduled`, "PUT")).body.kind).toBe("scheduled");
      await mf.dispose();
      mf = await runtime("TestAgent", "removed-job");
      const next = await telegram(1001, "hello");
      expect(await waitJob(task.body.id)).toMatchObject({ status: "failed", error: "unsupported_job_kind" });
      expect(await waitJob(next.body.id)).toMatchObject({ status: "complete", kind: "user" });
      expect(received.slice(before).map(message => message.text)).toEqual([...initialMessages, "本地测试回答。"]);
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
