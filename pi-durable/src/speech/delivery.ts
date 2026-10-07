import type { Env } from "../env.js";
import { ownerId, requiredSecret } from "../env.js";
import { textField } from "../http.js";
import { TelegramBot, TelegramError } from "../telegram.js";
import { MAX_SPEECH_CHARS, SpeechClient, SpeechError } from "./client.js";

export interface SpeechReceipt {
  inputHash: string;
  status: "generating" | "sending" | "sent" | "failed" | "uncertain";
  messageId?: number;
  bytes?: number;
  error?: string;
}

export interface SpeechJournal {
  // Atomic claim: only one external speech send per user job, even if the
  // model calls the tool again with a new call ID or altered text.
  claim(candidate: SpeechReceipt): Promise<SpeechReceipt | undefined>;
  save(receipt: SpeechReceipt): Promise<void>;
}

export class SpeechDelivery {
  constructor(private readonly env: Env, private readonly journal: SpeechJournal, private readonly fetcher: typeof fetch = fetch.bind(globalThis)) {}

  async send(text: string, replyTo?: number, signal?: AbortSignal) {
    textField(text, "speech text", MAX_SPEECH_CHARS);
    signal?.throwIfAborted();
    // Validate secrets/owner before claiming or making any network request.
    const chatId = Number(ownerId(this.env));
    const bot = new TelegramBot(requiredSecret(this.env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN"), this.fetcher);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const inputHash = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
    const receipt: SpeechReceipt = { inputHash, status: "generating" };
    const existing = await this.journal.claim(receipt);
    if (existing) {
      if (existing.inputHash === inputHash && existing.status === "sent") return { sent: true, messageId: existing.messageId, bytes: existing.bytes, format: "mp3", duplicate: true };
      // Neither interrupted sends nor known failures are blindly reissued.
      // Explicitly ask the user for a NEW request if another send is needed.
      throw new SpeechError(existing.inputHash !== inputHash ? "speech_one_per_request" : existing.error ?? "speech_already_attempted_check_telegram");
    }
    try {
      const audio = await new SpeechClient(this.env, this.fetcher).generate(text, signal);
      signal?.throwIfAborted();
      receipt.bytes = audio.size;
      receipt.status = "sending";
      // Persist intent before upload. A crash at/after this point is ambiguous.
      await this.journal.save(receipt);
      signal?.throwIfAborted();
      receipt.messageId = await bot.sendVoice(chatId, audio, replyTo, signal);
      receipt.status = "sent";
      await this.journal.save(receipt);
      return { sent: true, messageId: receipt.messageId, bytes: audio.size, format: "mp3" };
    } catch (error) {
      const uncertain = receipt.status === "sent" || (receipt.status === "sending" && !(error instanceof TelegramError && !error.uncertain));
      receipt.status = uncertain ? "uncertain" : "failed";
      receipt.error = uncertain ? "speech_delivery_uncertain_check_telegram" : error instanceof SpeechError ? error.code : error instanceof TelegramError ? "speech_telegram_rejected" : "speech_failed";
      await this.journal.save(receipt);
      throw new SpeechError(receipt.error);
    }
  }
}
