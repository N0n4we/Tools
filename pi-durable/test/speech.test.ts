import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Env } from "../src/env.js";
import { MAX_AUDIO_BYTES, SpeechClient } from "../src/speech/client.js";
import { SpeechDelivery, type SpeechJournal, type SpeechReceipt } from "../src/speech/delivery.js";
import { speechExtension } from "../src/speech/extension.js";

const env = { OPENROUTER_API_KEY: "private-api-key", TELEGRAM_BOT_TOKEN: "private-bot-key", TELEGRAM_USER_ID: "123" } as Env;
const mp3 = () => { const bytes = new Uint8Array(512); bytes.set([0x49, 0x44, 0x33]); return bytes; };
const audio = () => new Response(mp3(), { headers: { "content-type": "audio/mpeg" } });
const fetcher = (fn: (...args: any[]) => Promise<Response>) => vi.fn(fn) as unknown as typeof fetch;

function journal() {
  let receipt: SpeechReceipt | undefined;
  const storage: SpeechJournal = {
    async claim(candidate) { const existing = receipt; if (!existing) receipt = structuredClone(candidate); return structuredClone(existing); },
    async save(value) { receipt = structuredClone(value); },
  };
  return { storage, get: () => receipt };
}

describe("HTTP MP3 synthesis", () => {
  it("uses the existing OpenRouter secret, fixed endpoint and native MP3", async () => {
    const mock = fetcher(async () => audio());
    const result = await new SpeechClient(env, mock).generate("你好");
    expect(result.size).toBe(512);
    expect(result.type).toBe("audio/mpeg");
    const [url, options] = vi.mocked(mock).mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(options).toMatchObject({ method: "POST", redirect: "manual", headers: { authorization: "Bearer private-api-key" } });
    expect(JSON.parse(options!.body as string)).toEqual({ model: "bytedance-seed/seed-audio-1-0", input: "你好", response_format: "mp3" });
  });

  it("permits a server-side model override and MPEG frame signature without ID3", async () => {
    const bytes = mp3(); bytes.set([0xff, 0xfb, 0x90]);
    const mock = fetcher(async () => new Response(bytes, { headers: { "content-type": "audio/mp3; charset=binary" } }));
    expect((await new SpeechClient({ ...env, TTS_MODEL: "configured-model" }, mock).generate("测试")).size).toBe(512);
    expect(JSON.parse(vi.mocked(mock).mock.calls[0]![1]!.body as string)).toMatchObject({ input: "测试", model: "configured-model" });
  });

  it.each(["", "  ", "中".repeat(1001)])("rejects invalid input before network (%#)", async text => {
    const mock = fetcher(async () => audio());
    await expect(new SpeechClient(env, mock).generate(text)).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });

  it("fails explicitly when the API secret is missing", async () => {
    const mock = fetcher(async () => audio());
    await expect(new SpeechClient({ OPENROUTER_API_KEY: "" }, mock).generate("你好")).rejects.toMatchObject({ code: "speech_not_configured" });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([302, 401, 429, 500])("does not follow redirects or expose provider error bodies (%i)", async status => {
    const mock = fetcher(async () => new Response("private-api-key echoed input", { status, headers: { location: "https://evil.invalid" } }));
    await expect(new SpeechClient(env, mock).generate("你好")).rejects.toMatchObject({ code: status === 429 ? "speech_rate_limited" : "speech_provider_rejected" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each(["application/json", "audio/pcm;rate=24000;channels=2", "text/html"])("rejects non-MP3 content types (%s)", async type => {
    const mock = fetcher(async () => new Response(mp3(), { headers: { "content-type": type } }));
    await expect(new SpeechClient(env, mock).generate("你好")).rejects.toMatchObject({ code: "speech_expected_mp3" });
  });

  it.each([new Uint8Array(0), new Uint8Array(200), new TextEncoder().encode('{"error":"private-api-key"}')])("rejects empty/invalid MP3 bodies (%#)", async bytes => {
    const mock = fetcher(async () => new Response(bytes, { headers: { "content-type": "audio/mpeg" } }));
    await expect(new SpeechClient(env, mock).generate("你好")).rejects.toMatchObject({ code: "speech_invalid_mp3" });
  });

  it("caps both declared and streamed response sizes and cancels oversized streams", async () => {
    const mock = fetcher(async () => new Response(mp3(), { headers: { "content-type": "audio/mpeg", "content-length": String(MAX_AUDIO_BYTES + 1) } }));
    await expect(new SpeechClient(env, mock).generate("你好")).rejects.toMatchObject({ code: "speech_audio_too_large" });
    const cancel = vi.fn();
    const streamed = fetcher(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_AUDIO_BYTES)); c.enqueue(new Uint8Array(1)); }, cancel }), { headers: { "content-type": "audio/mpeg" } }));
    await expect(new SpeechClient(env, streamed).generate("你好")).rejects.toMatchObject({ code: "speech_audio_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("forwards cancellation, uses a timeout signal and redacts network failures", async () => {
    const controller = new AbortController();
    const mock = fetcher(async (_url, options) => { expect(options.signal).toBeDefined(); controller.abort(); throw new Error("private-api-key"); });
    await expect(new SpeechClient(env, mock).generate("你好", controller.signal)).rejects.toMatchObject({ code: "speech_cancelled" });
    const failed = fetcher(async () => { throw new Error("private-api-key"); });
    await expect(new SpeechClient(env, failed).generate("你好")).rejects.toMatchObject({ message: "speech_network_failed" });
  });
});

describe("owner-only durable speech delivery", () => {
  it("uploads once, persists intent and returns the receipt on repeated calls", async () => {
    const ledger = journal();
    const mock = fetcher(async (url, options) => {
      if (String(url).startsWith("https://openrouter.ai/")) return audio();
      expect(ledger.get()?.status).toBe("sending");
      expect(String(url)).toBe("https://api.telegram.org/botprivate-bot-key/sendVoice");
      const form = options.body as FormData;
      expect(form.get("chat_id")).toBe("123");
      expect(JSON.parse(form.get("reply_parameters") as string)).toMatchObject({ message_id: 99 });
      expect((form.get("voice") as File).name).toBe("speech.mp3");
      return Response.json({ ok: true, result: { message_id: 456 } });
    });
    const delivery = new SpeechDelivery(env, ledger.storage, mock);
    expect(await delivery.send("你好", 99)).toMatchObject({ sent: true, messageId: 456, bytes: 512, format: "mp3" });
    expect(await delivery.send("你好", 99)).toMatchObject({ sent: true, messageId: 456, duplicate: true });
    await expect(delivery.send("其他文本")).rejects.toMatchObject({ code: "speech_one_per_request" });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(ledger.get()).toMatchObject({ status: "sent", messageId: 456 });
    expect(JSON.stringify(ledger.get())).not.toContain("你好");
    expect(JSON.stringify(ledger.get())).not.toContain("private");
  });

  it("atomically claims concurrent calls before generation", async () => {
    const ledger = journal();
    let started!: () => void;
    let release!: () => void;
    const generating = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const mock = fetcher(async url => {
      if (String(url).startsWith("https://openrouter.ai/")) { started(); await gate; return audio(); }
      return Response.json({ ok: true, result: { message_id: 1 } });
    });
    const delivery = new SpeechDelivery(env, ledger.storage, mock);
    const first = delivery.send("你好");
    await generating;
    await expect(delivery.send("你好")).rejects.toMatchObject({ code: "speech_already_attempted_check_telegram" });
    release();
    expect(await first).toMatchObject({ sent: true });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("does not upload after synthesis failure or cancellation", async () => {
    const ledger = journal();
    const mock = fetcher(async () => Response.json({ error: "private-api-key" }, { status: 500 }));
    await expect(new SpeechDelivery(env, ledger.storage, mock).send("你好")).rejects.toMatchObject({ code: "speech_provider_rejected" });
    expect(ledger.get()?.status).toBe("failed");
    expect(mock).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const cancelled = fetcher(async () => { controller.abort(); return audio(); });
    await expect(new SpeechDelivery(env, journal().storage, cancelled).send("你好", undefined, controller.signal)).rejects.toMatchObject({ code: "speech_cancelled" });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("never retries an ambiguous Telegram upload", async () => {
    const ledger = journal();
    const mock = fetcher(async url => { if (String(url).startsWith("https://openrouter.ai/")) return audio(); throw new Error("private-bot-key"); });
    const delivery = new SpeechDelivery(env, ledger.storage, mock);
    await expect(delivery.send("你好")).rejects.toMatchObject({ code: "speech_delivery_uncertain_check_telegram" });
    await expect(delivery.send("你好")).rejects.toMatchObject({ code: "speech_delivery_uncertain_check_telegram" });
    expect(ledger.get()?.status).toBe("uncertain");
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("records a known Telegram rejection without claiming success or retrying", async () => {
    const ledger = journal();
    const mock = fetcher(async url => String(url).startsWith("https://openrouter.ai/") ? audio() : Response.json({ ok: false, description: "private-bot-key", parameters: { retry_after: 2 } }, { status: 429 }));
    const delivery = new SpeechDelivery(env, ledger.storage, mock);
    await expect(delivery.send("你好")).rejects.toMatchObject({ code: "speech_telegram_rejected" });
    await expect(delivery.send("你好")).rejects.toMatchObject({ code: "speech_telegram_rejected" });
    expect(ledger.get()?.status).toBe("failed");
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it.each(["generating", "sending"] as const)("does not replay an interrupted %s intent after restart", async status => {
    const ledger = journal();
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("你好"));
    await ledger.storage.save({ inputHash: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join(""), status });
    const mock = fetcher(async () => audio());
    await expect(new SpeechDelivery(env, ledger.storage, mock).send("你好")).rejects.toMatchObject({ code: "speech_already_attempted_check_telegram" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects invalid owners before any external request", async () => {
    const mock = fetcher(async () => audio());
    await expect(new SpeechDelivery({ ...env, TELEGRAM_USER_ID: "-1" }, journal().storage, mock).send("你好")).rejects.toThrow("positive safe integer");
    expect(mock).not.toHaveBeenCalled();
  });

  it("exposes only a text argument, is unsafe to replay and blocks automatic wakeup jobs", async () => {
    const mock = fetcher(async () => audio());
    const extension = speechExtension(new SpeechDelivery(env, journal().storage, mock), undefined, false);
    const tool = extension.tools![0]!;
    expect(tool.name).toBe("telegram_speak");
    expect(tool.replay).toBe("unsafe");
    expect(Object.keys(tool.parameters.properties)).toEqual(["text"]);
    expect(tool.parameters.additionalProperties).toBe(false);
    const result = await tool.execute({ text: "你好" }, undefined as never, BACKGROUND_CONTEXT);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("speech_requires_user_request");
    expect(mock).not.toHaveBeenCalled();
  });
});
