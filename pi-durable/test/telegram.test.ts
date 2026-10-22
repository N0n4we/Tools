import { describe, expect, it, vi } from "vitest";
import { TelegramBot, activityEvidence, renderTelegramView, splitTelegramText, telegramInput } from "../src/telegram.js";

const message = { message_id: 1, from: { id: 123 }, chat: { id: 123, type: "private" }, text: "你好" };

describe("Telegram", () => {
  it("renders normal Markdown and keeps technical activity separate and literal", () => {
    expect(renderTelegramView({ type: "text", text: "**正文**" }, "rich")).toEqual({ rich_message: { markdown: "**正文**" } });
    expect(renderTelegramView({ type: "thinking", text: "<b>literal</b> https://example.com" }, "html")).toEqual({ parse_mode: "HTML", text: "<blockquote expandable>&lt;b&gt;literal&lt;/b&gt; https://\u200bexample.com</blockquote>" });
    expect(renderTelegramView({ type: "text", text: "<unsafe>&" }, "html")).toEqual({ parse_mode: "HTML", text: "&lt;unsafe&gt;&amp;" });
    const tool = { type: "tool" as const, name: "bash", args: '{"command":"sleep 120s"}', status: "running" as const };
    expect(renderTelegramView(tool, "rich")).toEqual({ rich_message: { skip_entity_detection: true, blocks: [{
      type: "details", summary: [{ type: "bold", text: "bash:" }, " ", { type: "code", text: "running" }],
      blocks: [{ type: "details", summary: { type: "code", text: "arguments" }, is_open: true, blocks: [{ type: "pre", language: "json", text: tool.args }] }],
    }] } });
    expect(renderTelegramView(tool, "html")).toEqual({ parse_mode: "HTML", text: `<b>bash:</b> <code>running</code>\n<blockquote expandable>${tool.args}</blockquote>` });
  });
  it("redacts known secret shapes before bounding technical evidence and preserves emoji", () => {
    const text = 'api_key="private-key" password=private-password Bearer abcdefghijklmnopqrstuvwxyz 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefg';
    expect(activityEvidence(text)).not.toMatch(/private-key|private-password|abcdefghijklmnopqrstuvwxyz|123456789:/);
    for (const tail of [false, true]) {
      const bounded = activityEvidence("中😀".repeat(1000), tail);
      expect(bounded).toContain("截断");
      expect(bounded).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });
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
    expect(body).toMatchObject({ chat_id: 123, reply_parameters: { message_id: 1 }, link_preview_options: { is_disabled: true } });
    expect(body.parse_mode).toBeUndefined();
  });
  it("deletes only the supplied message IDs and validates Telegram batch limits", async () => {
    const mock = vi.fn(async () => Response.json({ ok: true, result: true })) as unknown as typeof fetch;
    const bot = new TelegramBot("test", mock);
    await bot.deleteMessages(123, [9, 10]);
    expect(vi.mocked(mock).mock.calls[0]?.[0]).toMatch(/\/deleteMessages$/);
    expect(JSON.parse(vi.mocked(mock).mock.calls[0]![1]!.body as string)).toEqual({ chat_id: 123, message_ids: [9, 10] });
    for (const ids of [[], [0], [1.5], [NaN], Array.from({ length: 101 }, (_, i) => i + 1)]) await expect(bot.deleteMessages(123, ids)).rejects.toThrow("Expected 1–100 Telegram message IDs");
    expect(mock).toHaveBeenCalledTimes(1);
    const rejected = vi.fn(async () => Response.json({ ok: false }, { status: 400 })) as unknown as typeof fetch;
    await expect(new TelegramBot("test", rejected).deleteMessages(123, [9])).rejects.toMatchObject({ statusCode: 400, uncertain: false });
    const malformed = vi.fn(async () => Response.json({ ok: true, result: {} })) as unknown as typeof fetch;
    await expect(new TelegramBot("test", malformed).deleteMessages(123, [9])).rejects.toMatchObject({ uncertain: true });
  });
  it("distinguishes a known rate-limit rejection from uncertain delivery", async () => {
    const rateLimit = vi.fn(async () => Response.json({ ok: false, description: "private-request-data", parameters: { retry_after: 2 } }, { status: 429 })) as unknown as typeof fetch;
    await expect(new TelegramBot("test", rateLimit).send(123, "x")).rejects.toMatchObject({ retryable: true, retryAfter: 2, uncertain: false, message: "Telegram delivery failed" });
    const network = vi.fn(async () => { throw new Error("do not log credentials"); }) as unknown as typeof fetch;
    await expect(new TelegramBot("test", network).send(123, "x")).rejects.toMatchObject({ uncertain: true, retryable: false, message: "Telegram delivery failed" });
  });
  it("sends Rich prose and edits a persistent HTML thinking message without re-quoting", async () => {
    const mock = vi.fn(async () => Response.json({ ok: true, result: { message_id: 9 } })) as unknown as typeof fetch;
    const bot = new TelegramBot("test", mock);
    expect(await bot.publish(123, { type: "text", text: "**正文**" }, 1)).toEqual({ messageId: 9, format: "rich" });
    expect(vi.mocked(mock).mock.calls[0]?.[0]).toMatch(/\/sendRichMessage$/);
    expect(JSON.parse(vi.mocked(mock).mock.calls[0]![1]!.body as string)).toMatchObject({ rich_message: { markdown: "**正文**" }, reply_parameters: { message_id: 1 } });
    await bot.publish(123, { type: "thinking", text: "更多思考" }, 1, undefined, 9);
    expect(vi.mocked(mock).mock.calls[1]?.[0]).toMatch(/\/editMessageText$/);
    const body = JSON.parse(vi.mocked(mock).mock.calls[1]![1]!.body as string);
    expect(body).toMatchObject({ message_id: 9, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    expect(body.reply_parameters).toBeUndefined();
    expect(body.rich_message).toBeUndefined();
  });
  it("falls back once only for a confirmed Rich send rejection, never for an edit or unknown send", async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 9 } })) as unknown as typeof fetch;
    expect(await new TelegramBot("test", mock).publish(123, { type: "text", text: "<bad>&" })).toEqual({ messageId: 9, format: "html" });
    expect(vi.mocked(mock).mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual(["sendRichMessage", "sendMessage"]);
    expect(JSON.parse(vi.mocked(mock).mock.calls[1]![1]!.body as string).text).toBe("&lt;bad&gt;&amp;");
    for (const edit of [false, true]) {
      const uncertain = vi.fn(async () => { throw new Error("unknown ACK"); }) as unknown as typeof fetch;
      await expect(new TelegramBot("test", uncertain).publish(123, { type: "text", text: "正文" }, undefined, undefined, edit ? 9 : undefined)).rejects.toMatchObject({ uncertain: true });
      expect(uncertain).toHaveBeenCalledTimes(1);
    }
    const rejectedEdit = vi.fn(async () => Response.json({ ok: false }, { status: 400 })) as unknown as typeof fetch;
    await expect(new TelegramBot("test", rejectedEdit).publish(123, { type: "text", text: "正文" }, undefined, undefined, 9)).rejects.toMatchObject({ uncertain: false });
    expect(rejectedEdit).toHaveBeenCalledTimes(1);
  });
  it("accepts unchanged edits but rejects successful sends without a verifiable message ID", async () => {
    const unchanged = vi.fn(async () => Response.json({ ok: false, description: "Bad Request: message is not modified" }, { status: 400 })) as unknown as typeof fetch;
    expect(await new TelegramBot("test", unchanged).publish(123, { type: "thinking", text: "原内容" }, undefined, undefined, 9)).toEqual({ messageId: 9, format: "html" });
    for (const result of [{}, true]) {
      const mock = vi.fn(async () => Response.json({ ok: true, result })) as unknown as typeof fetch;
      await expect(new TelegramBot("test", mock).publish(123, { type: "text", text: "正文" })).rejects.toMatchObject({ uncertain: true });
      expect(mock).toHaveBeenCalledTimes(1);
    }
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
