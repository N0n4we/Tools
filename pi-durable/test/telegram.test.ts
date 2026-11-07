import { describe, expect, it, vi } from "vitest";
import { MAX_TELEGRAM_IMAGE_BYTES, TelegramBot, activityEvidence, renderTelegramView, splitTelegramText, telegramImage, telegramInput, telegramVideo } from "../src/telegram.js";
import { MAX_VIDEO_BYTES } from "../src/video/store.js";

const message = { message_id: 1, from: { id: 123 }, chat: { id: 123, type: "private" }, text: "你好" };
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII="), char => char.charCodeAt(0));

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
  it("accepts photos with their captions and selects the largest usable resolution", () => {
    const photo = [
      { file_id: "large", width: 1280, height: 960, file_size: MAX_TELEGRAM_IMAGE_BYTES + 1 },
      { file_id: "medium", width: 800, height: 600, file_size: 900_000 },
      { file_id: "small", width: 320, height: 240, file_size: 50_000 },
    ];
    expect(telegramInput({ update_id: 42, message: { ...message, text: undefined, photo, caption: "看看这张图" } }, "123")).toMatchObject({
      text: "看看这张图", image: { fileId: "medium", fileSize: 900_000 },
    });
    expect(telegramInput({ update_id: 42, message: { ...message, text: undefined, photo: [{ file_id: "original", width: 1280, height: 960 }] } }, "123")).toMatchObject({
      text: "", image: { fileId: "original" },
    });
    expect(telegramInput({ update_id: 42, message: { ...message, photo, from: { id: 456 } } }, "123")).toBeNull();
  });
  it.each(["photo", "video"])("preserves an album ID and rejects invalid group metadata (%s)", kind => {
    const media = kind === "photo" ? { photo: [{ file_id: "image", width: 100, height: 100 }] } : { video: { file_id: "video" } };
    expect(telegramInput({ update_id: 42, message: { ...message, ...media, media_group_id: "album-123" } }, "123")).toMatchObject({ mediaGroupId: "album-123" });
    for (const media_group_id of ["", 123, "x".repeat(257)]) expect(() => telegramInput({ update_id: 42, message: { ...message, ...media, media_group_id } }, "123")).toThrow();
  });
  it.each(["image/jpeg", "image/png", "image/webp", "image/gif"])("accepts an image sent as a document: %s", mimeType => {
    expect(telegramInput({ update_id: 42, message: { ...message, text: undefined, document: { file_id: "document", mime_type: mimeType, file_size: 1024 }, caption: "原图" } }, "123")).toMatchObject({
      text: "原图", image: { fileId: "document", fileSize: 1024 },
    });
  });
  it("ignores unsupported media and validates image metadata and caption limits", () => {
    for (const media of [{ document: { file_id: "pdf", mime_type: "application/pdf" } }, { document: { file_id: "svg", mime_type: "image/svg+xml" } }, { video: {} }, { photo: [] }]) {
      expect(telegramInput({ update_id: 42, message: { ...message, text: undefined, caption: "说明", ...media } }, "123")).toBeNull();
    }
    const photo = [{ file_id: "image", width: 100, height: 100 }];
    expect(() => telegramInput({ update_id: 42, message: { ...message, photo, caption: "x".repeat(8001) } }, "123")).toThrow("too long");
    expect(telegramImage(undefined)).toBeUndefined();
    for (const value of [null, [], {}, { fileId: "" }, { fileId: "x", fileSize: -1 }, { fileId: "x", fileSize: 1.5 }]) expect(() => telegramImage(value)).toThrow();
  });
  it("downloads image bytes through getFile and returns inline content without a token-bearing URL", async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: "photos/file_1.png", file_size: png.length } }))
      .mockResolvedValueOnce(new Response(png, { headers: { "content-type": "application/octet-stream" } })) as unknown as typeof fetch;
    const content = await new TelegramBot("test-token", mock).downloadImage({ fileId: "photo-id" });
    expect(content).toEqual({ type: "image", mimeType: "image/png", data: btoa(String.fromCharCode(...png)) });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(mock).mock.calls[0]?.[0]).toBe("https://api.telegram.org/bottest-token/getFile");
    expect(JSON.parse(vi.mocked(mock).mock.calls[0]![1]!.body as string)).toEqual({ file_id: "photo-id" });
    expect(vi.mocked(mock).mock.calls[1]?.[0]).toBe("https://api.telegram.org/file/bottest-token/photos/file_1.png");
    expect(vi.mocked(mock).mock.calls.every(([, options]) => options?.redirect === "manual")).toBe(true);
    expect(JSON.stringify(content)).not.toMatch(/test-token|https:/);
  });
  it.each([
    [new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [new TextEncoder().encode("GIF89a"), "image/gif"],
    [new TextEncoder().encode("RIFF0000WEBP"), "image/webp"],
  ])("detects the actual supported image format", async (bytes, mimeType) => {
    const mock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: "documents/file.bin" } }))
      .mockResolvedValueOnce(new Response(bytes)) as unknown as typeof fetch;
    expect(await new TelegramBot("test", mock).downloadImage({ fileId: "image" })).toMatchObject({ mimeType });
  });
  it("bounds image metadata, download headers and streamed bytes", async () => {
    const mock = vi.fn() as unknown as typeof fetch;
    await expect(new TelegramBot("test", mock).downloadImage({ fileId: "large", fileSize: MAX_TELEGRAM_IMAGE_BYTES + 1 })).rejects.toMatchObject({ status: 413 });
    expect(mock).not.toHaveBeenCalled();
    vi.mocked(mock).mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: "photos/file.png", file_size: MAX_TELEGRAM_IMAGE_BYTES + 1 } }));
    await expect(new TelegramBot("test", mock).downloadImage({ fileId: "large" })).rejects.toMatchObject({ status: 413 });
    expect(mock).toHaveBeenCalledTimes(1);
    for (const response of [new Response(png, { headers: { "content-length": String(MAX_TELEGRAM_IMAGE_BYTES + 1) } }), new Response(new Uint8Array(MAX_TELEGRAM_IMAGE_BYTES + 1))]) {
      const fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: "photos/file.png" } }))
        .mockResolvedValueOnce(response) as unknown as typeof fetch;
      await expect(new TelegramBot("test", fetcher).downloadImage({ fileId: "large" })).rejects.toMatchObject({ status: 413 });
    }
  });
  it("rejects invalid images, unsafe paths, redirects and credential-bearing download errors", async () => {
    for (const file_path of ["../file.png", "/file.png", "photos/../../file.png", "https://other.example/file.png", "photos/file.png?token=secret"]) {
      const mock = vi.fn(async () => Response.json({ ok: true, result: { file_path } })) as unknown as typeof fetch;
      await expect(new TelegramBot("secret", mock).downloadImage({ fileId: "image" })).rejects.toMatchObject({ status: 502, message: "下载 Telegram 图片失败，请稍后重发。" });
      expect(mock).toHaveBeenCalledTimes(1);
    }
    for (const [response, status] of [[new Response("not an image", { headers: { "content-type": "image/png" } }), 415], [new Response(null, { status: 302, headers: { location: "https://other.example/" } }), 502]] as const) {
      const mock = vi.fn()
        .mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: "photos/file.png" } }))
        .mockResolvedValueOnce(response) as unknown as typeof fetch;
      await expect(new TelegramBot("secret", mock).downloadImage({ fileId: "image" })).rejects.toMatchObject({ status });
      expect(mock).toHaveBeenCalledTimes(2);
    }
    const network = vi.fn(async () => { throw new Error("https://api.telegram.org/botsecret/getFile"); }) as unknown as typeof fetch;
    await expect(new TelegramBot("secret", network).downloadImage({ fileId: "image" })).rejects.toMatchObject({ status: 502, message: "下载 Telegram 图片失败，请稍后重发。" });
  });
  it("splits long answers without breaking emoji", () => {
    const text = "中😀".repeat(3000);
    const chunks = splitTelegramText(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });
  it.each(["video", "video_note", "animation", "document"])("accepts %s video messages and their captions", key => {
    const media = { file_id: "video-id", file_size: 1024, mime_type: "video/mp4" };
    expect(telegramInput({ update_id: 42, message: { ...message, text: undefined, [key]: media, caption: "/pop" } }, "123")).toMatchObject({ text: "/pop", video: { fileId: "video-id", fileSize: 1024 } });
    expect(telegramInput({ update_id: 42, message: { ...message, text: undefined, [key]: media } }, "123")).toMatchObject({ text: "", video: { fileId: "video-id" } });
    expect(telegramInput({ update_id: 42, message: { ...message, text: undefined, [key]: media, from: { id: 456 } } }, "123")).toBeNull();
  });

  it("validates video metadata and ignores unsupported video documents", () => {
    expect(telegramVideo(undefined)).toBeUndefined();
    for (const value of [null, [], {}, { fileId: "" }, { fileId: "video", fileSize: -1 }, { fileId: "video", fileSize: 1.5 }]) expect(() => telegramVideo(value)).toThrow();
    expect(telegramInput({ update_id: 42, message: { ...message, text: undefined, document: { file_id: "video", mime_type: "video/x-matroska" } } }, "123")).toBeNull();
    expect(() => telegramInput({ update_id: 42, message: { ...message, video: { file_id: "video" }, caption: "x".repeat(8001) } }, "123")).toThrow("too long");
  });

  it.each([
    [new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]), "video/mp4"],
    [new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 113, 116, 32, 32, 0, 0, 0, 0]), "video/mov"],
    [new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]), "video/webm"],
    [new Uint8Array([0, 0, 1, 0xba, 0x44]), "video/mpeg"],
  ])("downloads original video bytes and detects %s", async (bytes, mimeType) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: "videos/file.mp4", file_size: bytes.length } }))
      .mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    expect(await new TelegramBot("fixture-token", fetcher).downloadVideo({ fileId: "video-id" })).toEqual({ bytes, mimeType });
    expect(vi.mocked(fetcher).mock.calls[1]?.[0]).toBe("https://api.telegram.org/file/botfixture-token/videos/file.mp4");
    expect(vi.mocked(fetcher).mock.calls.every(([, options]) => options?.redirect === "manual")).toBe(true);
  });

  it("bounds video metadata, getFile metadata and streamed downloads", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(new TelegramBot("test", fetcher).downloadVideo({ fileId: "large", fileSize: MAX_VIDEO_BYTES + 1 })).rejects.toMatchObject({ status: 413, message: expect.stringContaining("20 MiB") });
    expect(fetcher).not.toHaveBeenCalled();
    vi.mocked(fetcher).mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: "videos/file.mp4", file_size: MAX_VIDEO_BYTES + 1 } }));
    await expect(new TelegramBot("test", fetcher).downloadVideo({ fileId: "large" })).rejects.toMatchObject({ status: 413 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const response of [new Response("", { headers: { "content-length": String(MAX_VIDEO_BYTES + 1) } }), new Response(new Uint8Array(MAX_VIDEO_BYTES + 1))]) {
      const download = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: "videos/file.mp4" } })).mockResolvedValueOnce(response) as unknown as typeof fetch;
      await expect(new TelegramBot("test", download).downloadVideo({ fileId: "large" })).rejects.toMatchObject({ status: 413 });
    }
  });

  it("rejects non-video bytes, redirects and unsafe paths without revealing download credentials", async () => {
    for (const bytes of [png, new TextEncoder().encode("not a video"), new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 97, 118, 105, 102, 0, 0, 0, 0])]) {
      const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: "videos/file.mp4" } })).mockResolvedValueOnce(new Response(bytes)) as unknown as typeof fetch;
      await expect(new TelegramBot("secret", fetcher).downloadVideo({ fileId: "video" })).rejects.toMatchObject({ status: 415 });
    }
    for (const file_path of ["../video.mp4", "https://example.com/video.mp4", "videos/file.mp4?token=secret"]) {
      const fetcher = vi.fn(async () => Response.json({ ok: true, result: { file_path } })) as unknown as typeof fetch;
      await expect(new TelegramBot("secret", fetcher).downloadVideo({ fileId: "video" })).rejects.toMatchObject({ status: 502, message: "下载 Telegram 视频失败，请稍后重发。" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const redirect = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: "videos/file.mp4" } })).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://other.example" } })) as unknown as typeof fetch;
    await expect(new TelegramBot("secret", redirect).downloadVideo({ fileId: "video" })).rejects.toMatchObject({ status: 502 });
    const failed = vi.fn(async () => { throw new Error("https://api.telegram.org/botsecret/getFile"); }) as unknown as typeof fetch;
    await expect(new TelegramBot("secret", failed).downloadVideo({ fileId: "video" })).rejects.toMatchObject({ status: 502, message: "下载 Telegram 视频失败，请稍后重发。" });
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
