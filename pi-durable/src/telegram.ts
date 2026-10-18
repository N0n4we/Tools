import { HttpError, readLimited } from "./http.js";

export interface TelegramInput {
  updateId: number;
  chatId: number;
  messageId: number;
  text: string;
}

export function telegramInput(update: Record<string, unknown>, owner: string): TelegramInput | null {
  const message = update.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return null;
  const from = message.from as Record<string, unknown> | undefined;
  const chat = message.chat as Record<string, unknown> | undefined;
  if (!from || !chat || String(from.id) !== owner || String(chat.id) !== owner || chat.type !== "private" || from.is_bot === true) return null;
  if (!Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0 || !Number.isSafeInteger(message.message_id)) throw new HttpError(400, "Invalid Telegram update ID");
  if (typeof message.text !== "string" || !message.text.trim()) return null;
  if (message.text.length > 8_000) throw new HttpError(413, "Telegram message is too long");
  return { updateId: Number(update.update_id), chatId: Number(chat.id), messageId: Number(message.message_id), text: message.text };
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

export function activityEvidence(text: string, tail = false): string {
  const redacted = text
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

  private async call<T>(method: string, body: object | FormData = {}, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        // Workers supports only follow/manual; never forward bot credentials
        // through an unexpected redirect.
        method: "POST", ...(body instanceof FormData ? {} : { headers: { "content-type": "application/json" } }), redirect: "manual",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
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
