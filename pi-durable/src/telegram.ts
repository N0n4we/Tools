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

export class TelegramError extends Error {
  constructor(public readonly retryAfter: number, public readonly retryable: boolean, public readonly uncertain: boolean, public readonly errorCode?: number, public readonly reason?: string) {
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
    let json: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    try {
      const value: unknown = JSON.parse(await readLimited(response, 64 * 1024));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Telegram response");
      json = value;
    }
    catch { throw new TelegramError(30, false, true); }
    if (!response.ok || json.ok !== true) {
      const delay = Number(json.parameters?.retry_after ?? 30);
      // Never return the raw Telegram description: it can contain request data.
      const description = typeof json.description === "string" ? json.description.toLowerCase() : "";
      const reason = method === "setWebhook"
        ? /resolve host|resolve hostname/.test(description) ? "webhook_dns_failed"
          : /ssl|certificate|tls/.test(description) ? "webhook_tls_failed"
          : /webhook/.test(description) ? "webhook_rejected" : "api_rejected"
        : "api_rejected";
      throw new TelegramError(Number.isFinite(delay) ? Math.max(1, Math.min(3600, Math.ceil(delay))) : 30, response.status === 429 || response.status >= 500, false, json.error_code ?? response.status, reason);
    }
    if (json.result === undefined) throw new TelegramError(30, false, true);
    return json.result;
  }

  async send(chatId: number, text: string, replyTo?: number): Promise<number> {
    const result = await this.call<{ message_id?: number }>("sendMessage", {
      chat_id: chatId, text, ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
    if (!Number.isSafeInteger(result?.message_id)) throw new TelegramError(30, false, true);
    return result.message_id!;
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

  async status(owner: number) {
    const bot = await this.call<{ id: number; is_bot: boolean; username?: string }>("getMe");
    const webhook = await this.call<{ url: string; pending_update_count: number; last_error_date?: number }>("getWebhookInfo");
    if (!Number.isSafeInteger(bot?.id) || bot.is_bot !== true || typeof webhook?.url !== "string") throw new TelegramError(30, false, true);
    let ownerChatReady = false;
    try {
      const chat = await this.call<{ id: number; type: string }>("getChat", { chat_id: owner });
      ownerChatReady = chat?.id === owner && chat.type === "private";
    } catch (error) {
      // A user who has not started (or has blocked) the bot needs to act first.
      if (!(error instanceof TelegramError) || ![400, 403].includes(error.errorCode ?? 0)) throw error;
    }
    return { bot: { id: bot.id, username: bot.username }, ownerChatReady, webhook: { url: webhook.url, pendingUpdates: webhook.pending_update_count, lastErrorAt: webhook.last_error_date } };
  }

  async setWebhook(input: string, secret: string): Promise<void> {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.pathname !== "/telegram/webhook" || url.search || url.hash) {
      throw new HttpError(400, "Expected an HTTPS /telegram/webhook URL");
    }
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) throw new HttpError(503, "Configure a valid TELEGRAM_WEBHOOK_SECRET");
    const result = await this.call<boolean>("setWebhook", {
      url: url.href, secret_token: secret, allowed_updates: ["message"], max_connections: 1, drop_pending_updates: false,
    });
    if (result !== true) throw new TelegramError(30, false, true);
  }
}
