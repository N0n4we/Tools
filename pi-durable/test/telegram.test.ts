import { describe, expect, it, vi } from "vitest";
import { TelegramBot, splitTelegramText, telegramInput } from "../src/telegram.js";

const message = { message_id: 1, from: { id: 123 }, chat: { id: 123, type: "private" }, text: "你好" };

describe("Telegram", () => {
  it("admits only private messages from the configured owner", () => {
    expect(telegramInput({ update_id: 42, message }, "123")).toMatchObject({ updateId: 42, text: "你好" });
    expect(telegramInput({ update_id: 42, message: { ...message, from: { id: 456 } } }, "123")).toBeNull();
    expect(telegramInput({ update_id: 42, message: { ...message, chat: { id: -1, type: "group" } } }, "123")).toBeNull();
    expect(telegramInput({ update_id: 42, edited_message: message }, "123")).toBeNull();
  });
  it("splits long answers without breaking emoji", () => {
    const text = "中😀".repeat(3000);
    const chunks = splitTelegramText(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });
  it("uses the runtime token, plaintext text and optional reply parameters", async () => {
    const mock = vi.fn(async () => Response.json({ ok: true, result: { message_id: 9 } })) as unknown as typeof fetch;
    expect(await new TelegramBot("test-token", mock).send(123, "hello <b>literal</b>", 1)).toBe(9);
    const [url, options] = vi.mocked(mock).mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/bottest-token/sendMessage");
    const body = JSON.parse(options!.body as string);
    expect(body).toMatchObject({ chat_id: 123, reply_parameters: { message_id: 1 } });
    expect(body.parse_mode).toBeUndefined();
  });
  it("distinguishes a known rate-limit rejection from uncertain delivery", async () => {
    const rateLimit = vi.fn(async () => Response.json({ ok: false, description: "private-request-data", parameters: { retry_after: 2 } }, { status: 429 })) as unknown as typeof fetch;
    await expect(new TelegramBot("test", rateLimit).send(123, "x")).rejects.toMatchObject({ retryable: true, retryAfter: 2, uncertain: false, message: "Telegram delivery failed" });
    const network = vi.fn(async () => { throw new Error("do not log credentials"); }) as unknown as typeof fetch;
    await expect(new TelegramBot("test", network).send(123, "x")).rejects.toMatchObject({ uncertain: true, retryable: false, message: "Telegram delivery failed" });
  });
  it("uploads MP3 voice as multipart without manually setting the boundary", async () => {
    const mock = vi.fn(async () => Response.json({ ok: true, result: { message_id: 10 } })) as unknown as typeof fetch;
    const bytes = new Uint8Array(256);
    bytes.set([0x49, 0x44, 0x33]);
    expect(await new TelegramBot("test-token", mock).sendVoice(123, new Blob([bytes], { type: "audio/mpeg" }), 1)).toBe(10);
    const [url, options] = vi.mocked(mock).mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/bottest-token/sendVoice");
    expect(options!.headers).toBeUndefined();
    expect(options!.redirect).toBe("manual");
    const form = options!.body as FormData;
    expect(form.get("chat_id")).toBe("123");
    expect(form.get("voice")).toMatchObject({ name: "speech.mp3", type: "audio/mpeg", size: 256 });
    expect(JSON.parse(form.get("reply_parameters") as string)).toMatchObject({ message_id: 1, allow_sending_without_reply: true });
    expect(form.get("token")).toBeNull();
  });
  it("rejects invalid voice data and uncertain voice responses", async () => {
    const mock = vi.fn(async () => Response.json({ ok: true, result: {} })) as unknown as typeof fetch;
    await expect(new TelegramBot("test", mock).sendVoice(123, new Blob(["bad"], { type: "audio/pcm" }))).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
    await expect(new TelegramBot("test", mock).sendVoice(123, new Blob([new Uint8Array(256)], { type: "audio/mpeg" }))).rejects.toMatchObject({ uncertain: true });
  });
  it("rejects redirects without forwarding the bot token", async () => {
    const mock = vi.fn(async () => new Response(null, { status: 307, headers: { location: "https://other.example/" } })) as unknown as typeof fetch;
    await expect(new TelegramBot("test", mock).send(123, "x")).rejects.toMatchObject({ retryable: false, uncertain: false });
    expect(vi.mocked(mock).mock.calls).toHaveLength(1);
    expect(vi.mocked(mock).mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
});
