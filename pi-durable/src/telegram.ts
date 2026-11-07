import type { ImageContent } from "@earendil-works/pi-ai";
import { HttpError, readLimited, readLimitedBytes, textField } from "./http.js";
import { MAX_VIDEO_BYTES, type VideoMime } from "./video/store.js";

// Leave room for base64 and Pi metadata within Workers SQLite's 2 MB row limit.
export const MAX_TELEGRAM_IMAGE_BYTES = 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/mpeg", "video/mov", "video/quicktime"]);

export interface TelegramImage {
  fileId: string;
  fileSize?: number;
}
export type TelegramVideo = TelegramImage;

function telegramFile(value: unknown, kind: "image" | "video"): TelegramImage | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `Invalid Telegram ${kind}`);
  const { fileId, fileSize } = value as Record<string, unknown>;
  if (fileSize !== undefined && (!Number.isSafeInteger(fileSize) || Number(fileSize) < 1)) throw new HttpError(400, `Invalid Telegram ${kind} size`);
  return { fileId: textField(fileId, "Telegram file ID", 1024), ...(fileSize === undefined ? {} : { fileSize: Number(fileSize) }) };
}

export const telegramImage = (value: unknown): TelegramImage | undefined => telegramFile(value, "image");
export const telegramVideo = (value: unknown): TelegramVideo | undefined => telegramFile(value, "video");

function messageImage(message: Record<string, unknown>): TelegramImage | undefined {
  const photos = Array.isArray(message.photo) ? message.photo.filter((photo): photo is Record<string, unknown> =>
    !!photo && typeof photo === "object" && typeof photo.file_id === "string" && Number.isSafeInteger(photo.width) && Number(photo.width) > 0 && Number.isSafeInteger(photo.height) && Number(photo.height) > 0) : [];
  // Prefer the highest resolution that fits, rather than rejecting a photo whose
  // original size is too large when Telegram also supplies smaller variants.
  const fitting = photos.filter(photo => photo.file_size === undefined || Number(photo.file_size) <= MAX_TELEGRAM_IMAGE_BYTES);
  const photo = (fitting.length ? fitting : photos).reduce<Record<string, unknown> | undefined>((best, item) =>
    !best || Number(item.width) * Number(item.height) > Number(best.width) * Number(best.height) ? item : best, undefined);
  if (photo) return telegramImage({ fileId: photo.file_id, fileSize: photo.file_size });
  const document = message.document as Record<string, unknown> | undefined;
  if (document && typeof document === "object" && typeof document.mime_type === "string" && IMAGE_TYPES.has(document.mime_type)) {
    return telegramImage({ fileId: document.file_id, fileSize: document.file_size });
  }
}

function messageVideo(message: Record<string, unknown>): TelegramVideo | undefined {
  for (const key of ["video", "video_note", "animation", "document"]) {
    const file = message[key] as Record<string, unknown> | undefined;
    if (!file || typeof file !== "object" || typeof file.file_id !== "string") continue;
    if ((key === "animation" || key === "document") && !VIDEO_TYPES.has(String(file.mime_type))) continue;
    return telegramVideo({ fileId: file.file_id, fileSize: file.file_size });
  }
}

export interface TelegramInput {
  updateId: number;
  chatId: number;
  messageId: number;
  text: string;
  image?: TelegramImage;
  video?: TelegramVideo;
  mediaGroupId?: string;
}

export function telegramInput(update: Record<string, unknown>, owner: string): TelegramInput | null {
  const message = update.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return null;
  const from = message.from as Record<string, unknown> | undefined;
  const chat = message.chat as Record<string, unknown> | undefined;
  if (!from || !chat || String(from.id) !== owner || String(chat.id) !== owner || chat.type !== "private" || from.is_bot === true) return null;
  if (!Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0 || !Number.isSafeInteger(message.message_id)) throw new HttpError(400, "Invalid Telegram update ID");
  const image = messageImage(message);
  const video = image ? undefined : messageVideo(message);
  const content = image || video ? message.caption : message.text;
  const text = typeof content === "string" && content.trim() ? content : "";
  if (!text && !image && !video) return null;
  if (text.length > 8_000) throw new HttpError(413, "Telegram message is too long");
  const mediaGroupId = (image || video) && message.media_group_id !== undefined ? textField(message.media_group_id, "Telegram media group ID", 256) : undefined;
  return { updateId: Number(update.update_id), chatId: Number(chat.id), messageId: Number(message.message_id), text, ...(image ? { image } : {}), ...(video ? { video } : {}), ...(mediaGroupId ? { mediaGroupId } : {}) };
}

export function splitTelegramText(text: string, limit = 4_000): string[] {
  const chunks: string[] = [];
  let current = "";
  // Iteration by Unicode code point never cuts a surrogate pair in half.
  for (const char of text) {
    if (current.length + char.length > limit) { chunks.push(current); current = ""; }
    current += char;
  }
  if (current) chunks.push(current);
  return chunks;
}

export type TelegramView =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; args: string; status: "requested" | "running" | "done" | "failed" };
export type TelegramFormat = "rich" | "html";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const literalEvidence = (text: string) => escapeHtml(text.replace(/\b(https?:\/\/)(?=\S)/gi, "$1\u200b"));

export function stripTimePrefix(text: string): string {
  // shortcut: only bare leading metadata labels are removed; revise if the metadata envelope changes.
  return text.replace(/^(?:\s*\[(?:(?:\d{4}-\d{2}-\d{2} )?\d{2}[:-]\d{2}[:-]\d{2}|\d{4}-\d{2}-\d{2} (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))\][ \t]*(?:\r?\n)?)+/, "");
}

export function activityEvidence(text: string, tail = false): string {
  const redacted = stripTimePrefix(text)
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_BOT_TOKEN]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}\b/gi, "$1[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[REDACTED]");
  if (redacted.length <= 1200) return redacted;
  let retained = tail ? redacted.slice(-1200) : redacted.slice(0, 1200);
  retained = retained.replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, "");
  return tail ? `…（前文已截断）\n${retained}` : `${retained}\n…（已截断）`;
}

export function renderTelegramView(view: TelegramView, format: TelegramFormat): object {
  if (view.type === "thinking") return { text: `<blockquote expandable>${literalEvidence(view.text)}</blockquote>`, parse_mode: "HTML" };
  if (view.type === "text") return format === "rich" ? { rich_message: { markdown: view.text } } : { text: escapeHtml(view.text), parse_mode: "HTML" };
  if (format === "html") return { text: `<b>${escapeHtml(view.name)}:</b> <code>${view.status}</code>\n<blockquote expandable>${literalEvidence(view.args)}</blockquote>`, parse_mode: "HTML" };
  return { rich_message: { skip_entity_detection: true, blocks: [{
    type: "details", summary: [{ type: "bold", text: `${view.name}:` }, " ", { type: "code", text: view.status }],
    blocks: [{ type: "details", summary: { type: "code", text: "arguments" }, is_open: true, blocks: [{ type: "pre", language: "json", text: view.args }] }],
  }] } };
}

export class TelegramError extends Error {
  constructor(public readonly retryAfter: number, public readonly retryable: boolean, public readonly uncertain: boolean, public readonly statusCode = 0, public readonly notModified = false) {
    super("Telegram delivery failed");
    this.name = "TelegramError";
  }
}

export class TelegramBot {
  // Preserve the global fetch receiver when storing it on a class.
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch.bind(globalThis)) {}

  async downloadImage(image: TelegramImage, signal?: AbortSignal): Promise<ImageContent> {
    const tooLarge = () => new HttpError(413, "图片超过 1 MiB，请压缩后重发，或以照片方式发送。");
    try {
      const bytes = await this.downloadFile(image, MAX_TELEGRAM_IMAGE_BYTES, tooLarge, signal);
      // Check the bytes: Telegram document MIME types are supplied by the sender.
      const head = String.fromCharCode(...bytes.subarray(0, 12));
      const mimeType = head.startsWith("\x89PNG\r\n\x1a\n") ? "image/png"
        : head.startsWith("\xff\xd8\xff") ? "image/jpeg"
        : /^GIF8[79]a/.test(head) ? "image/gif"
        : head.startsWith("RIFF") && head.slice(8, 12) === "WEBP" ? "image/webp" : undefined;
      if (!mimeType) throw new HttpError(415, "图片格式无效，请发送 JPEG、PNG、WebP 或 GIF 图片。");
      let binary = "";
      for (let start = 0; start < bytes.length; start += 32_768) binary += String.fromCharCode(...bytes.subarray(start, start + 32_768));
      signal?.throwIfAborted();
      return { type: "image", mimeType, data: btoa(binary) };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Fetch errors may include the credential-bearing URL. Never expose them.
      throw new HttpError(502, "下载 Telegram 图片失败，请稍后重发。");
    }
  }

  async downloadVideo(video: TelegramVideo, signal?: AbortSignal): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: VideoMime }> {
    const tooLarge = () => new HttpError(413, "视频超过 20 MiB，请压缩或剪短后重发。");
    try {
      const bytes = await this.downloadFile(video, MAX_VIDEO_BYTES, tooLarge, signal, 60_000);
      const head = String.fromCharCode(...bytes.subarray(0, 4096));
      let mimeType: VideoMime | undefined;
      if (bytes.length >= 16 && head.slice(4, 8) === "ftyp") {
        const brand = head.slice(8, 12);
        if (brand === "qt  ") mimeType = "video/mov";
        else if (/^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |dash)$/.test(brand)) mimeType = "video/mp4";
      } else if (head.startsWith("\x1a\x45\xdf\xa3") && head.includes("webm")) mimeType = "video/webm";
      else if (head.startsWith("\x00\x00\x01\xba") || head.startsWith("\x00\x00\x01\xb3")) mimeType = "video/mpeg";
      if (!mimeType) throw new HttpError(415, "视频格式无效，请发送 MP4、MOV、WebM 或 MPEG 视频。");
      signal?.throwIfAborted();
      return { bytes, mimeType };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "下载 Telegram 视频失败，请稍后重发。");
    }
  }

  private async downloadFile(attachment: TelegramImage, maxBytes: number, tooLarge: () => HttpError, signal?: AbortSignal, timeoutMs = 20_000): Promise<Uint8Array<ArrayBuffer>> {
    if ((attachment.fileSize ?? 0) > maxBytes) throw tooLarge();
    const file = await this.call<{ file_path?: unknown; file_size?: unknown }>("getFile", { file_id: attachment.fileId }, signal);
    if (!file || typeof file.file_path !== "string" || !file.file_path.split("/").every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part))) throw new Error("Invalid file path");
    if (file.file_size !== undefined && (!Number.isSafeInteger(file.file_size) || Number(file.file_size) < 1)) throw new Error("Invalid file size");
    if (Number(file.file_size) > maxBytes) throw tooLarge();
    const response = await this.fetcher(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, {
      redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Download rejected"); }
    try { return await readLimitedBytes(response, maxBytes); }
    catch (error) { if (error instanceof HttpError && error.status === 413) throw tooLarge(); throw error; }
  }

  private async call<T>(method: string, body: object | FormData = {}, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        // Workers supports only follow/manual; never forward bot credentials
        // through an unexpected redirect.
        method: "POST", ...(body instanceof FormData ? {} : { headers: { "content-type": "application/json" } }), redirect: "manual",
        // Once a Telegram write has started, let its bounded request return its
        // receipt. Cancelling it mid-send would make /abort + /retry ambiguous.
        signal: method === "getFile" && signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        body: body instanceof FormData ? body : JSON.stringify(body),
      });
    } catch { throw new TelegramError(30, false, true); }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new TelegramError(30, false, false);
    }
    let json: { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    try {
      const value: unknown = JSON.parse(await readLimited(response, 64 * 1024));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Telegram response");
      json = value;
    }
    catch { throw new TelegramError(30, false, true); }
    if (!response.ok || json.ok !== true) {
      const delay = Number(json.parameters?.retry_after ?? 30);
      throw new TelegramError(Number.isFinite(delay) ? Math.max(1, Math.min(3600, Math.ceil(delay))) : 30, response.status === 429 || response.status >= 500, false, response.status, response.status === 400 && typeof json.description === "string" && json.description.includes("message is not modified"));
    }
    if (json.result === undefined) throw new TelegramError(30, false, true);
    return json.result;
  }

  async send(chatId: number, text: string, replyTo?: number, signal?: AbortSignal): Promise<number> {
    const result = await this.call<{ message_id?: number }>("sendMessage", {
      chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    }, signal);
    if (!Number.isSafeInteger(result?.message_id)) throw new TelegramError(30, false, true);
    return result.message_id!;
  }

  async deleteMessages(chatId: number, messageIds: number[], signal?: AbortSignal): Promise<void> {
    if (!messageIds.length || messageIds.length > 100 || messageIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new HttpError(400, "Expected 1–100 Telegram message IDs");
    const result = await this.call<true>("deleteMessages", { chat_id: chatId, message_ids: messageIds }, signal);
    if (result !== true) throw new TelegramError(0, false, true);
  }

  async publish(chatId: number, view: TelegramView, replyTo?: number, signal?: AbortSignal, messageId?: number, format: TelegramFormat = "rich"): Promise<{ messageId: number; format: TelegramFormat }> {
    if (view.type === "thinking") format = "html";
    const fields = { chat_id: chatId, link_preview_options: { is_disabled: true }, ...(messageId === undefined ? replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {} : { message_id: messageId }) };
    try {
      const result = await this.call<{ message_id?: number } | true>(messageId === undefined ? format === "rich" ? "sendRichMessage" : "sendMessage" : "editMessageText", { ...fields, ...renderTelegramView(view, format) }, signal);
      const id = result === true ? messageId : result?.message_id;
      if (!Number.isSafeInteger(id) || (messageId !== undefined && id !== messageId)) throw new TelegramError(0, false, true);
      return { messageId: id!, format };
    } catch (error) {
      if (messageId !== undefined && error instanceof TelegramError && error.notModified) return { messageId, format };
      // Only a confirmed Rich send rejection permits another non-idempotent send.
      if (messageId === undefined && format === "rich" && error instanceof TelegramError && error.statusCode === 400 && !error.uncertain) return this.publish(chatId, view, replyTo, signal, undefined, "html");
      throw error;
    }
  }

  // Telegram sendVoice accepts MP3 as well as OGG/Opus. Upload bytes directly:
  // no public audio URL, token in form fields, or external transcoding service.
  async sendVoice(chatId: number, audio: Blob, replyTo?: number, signal?: AbortSignal): Promise<number> {
    if (audio.type !== "audio/mpeg" || audio.size < 128 || audio.size > 5 * 1024 * 1024) throw new HttpError(400, "Expected an MP3 voice file of at most 5 MiB");
    signal?.throwIfAborted();
    const body = new FormData();
    body.set("chat_id", String(chatId));
    body.set("voice", audio, "speech.mp3");
    if (replyTo) body.set("reply_parameters", JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
    const result = await this.call<{ message_id?: number }>("sendVoice", body, signal);
    if (!Number.isSafeInteger(result?.message_id)) throw new TelegramError(30, false, true);
    return result.message_id!;
  }
}
