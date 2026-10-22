import { AssistantEntry, ToolResultEntry, type EntryRecord, type TaskRecord, type ToolTaskCheckpoint, type ToolTaskInput } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import { requiredSecret } from "./env.js";
import { HttpError } from "./http.js";
import { activityEvidence, splitTelegramText, stripTimePrefix, TelegramBot, TelegramError, type TelegramFormat, type TelegramView } from "./telegram.js";

export interface TextDelivery {
  status: "pending" | "running" | "ready" | "sending" | "complete" | "failed";
  parts?: (string | TelegramView)[];
  sentIds?: number[];
  nextPart: number;
  deliveryAttempts: number;
  retryAt?: number;
  error?: string;
  presentation?: "blocks";
  revision?: number;
  editId?: number;
  format?: TelegramFormat;
}

export function replyParts(reply: string): string[] {
  const text = stripTimePrefix(reply);
  if (!text.trim()) return [];
  let truncated = text.slice(0, 20_000);
  if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1);
  return splitTelegramText(truncated);
}

export class TelegramOutput {
  private readonly tools = new Map<string, { key: string; view: Extract<TelegramView, { type: "tool" }> }>();
  private readonly progressAt = new Map<string, number>();

  constructor(private readonly storage: DurableObjectStorage, private readonly token: string | undefined, private readonly job: { id: string; chatId?: number; replyTo?: number; retry?: { replyTo: number } }) {}

  async removeReplies(from: { entry: number; after: number; replyTo: number; sequence: number }): Promise<void> {
    if (this.job.chatId === undefined) throw new HttpError(400, "Retry requires a Telegram chat");
    const bot = new TelegramBot(requiredSecret(this.token, "TELEGRAM_BOT_TOKEN"));
    const seen = new Set<number>();
    let batch: number[] = [];
    // shortcut: scans saved receipts; index by input boundary if cleanup becomes slow.
    for (const prefix of ["assistant:", "thinking:", "job:", "speech:"]) {
      let startAfter: string | undefined;
      while (true) {
        const page = await this.storage.list<{ sentIds?: number[]; editId?: number; messageId?: number; sequence?: number; status?: string; error?: string }>({ prefix, startAfter, limit: 100 });
        if (!page.size) break;
        for (const [key, receipt] of page) {
          startAfter = key;
          const related = prefix === "assistant:" ? Number(key.split(":")[1]) > from.entry
            : prefix === "thinking:" ? Number(key.split(":")[2]) >= from.after
            : prefix === "job:" ? (receipt.sequence ?? 0) >= from.sequence
            : ((await this.storage.get<{ sequence: number }>(`job:${key.slice(prefix.length)}`))?.sequence ?? 0) >= from.sequence;
          if (related && (receipt.status === "sending" || receipt.status === "uncertain" || receipt.error === "telegram_delivery_uncertain") && !receipt.editId && !receipt.messageId) throw new HttpError(409, "上次回复的发送回执不完整，无法确认应删除的 Telegram 消息；未重试。");
          for (const id of [...(receipt.sentIds ?? []), receipt.editId, receipt.messageId]) {
            if (id === undefined || (!related && id <= from.replyTo) || seen.has(id)) continue;
            seen.add(id);
            batch.push(id);
            if (batch.length === 100) { await bot.deleteMessages(this.job.chatId, batch); batch = []; }
          }
        }
      }
    }
    if (batch.length) await bot.deleteMessages(this.job.chatId, batch);
  }

  async deliver(key: string, delivery: TextDelivery, signal?: AbortSignal): Promise<void> {
    if (delivery.status === "complete" || delivery.status === "failed") return;
    if (delivery.status === "sending") {
      // Telegram has no outgoing idempotency key; never replay an unacknowledged send or edit.
      delivery.status = "failed";
      delivery.error = "telegram_delivery_uncertain";
      await this.storage.put(key, delivery);
      return;
    }
    if (delivery.retryAt && delivery.retryAt > Date.now()) return;
    for (; this.job.chatId !== undefined && delivery.nextPart < (delivery.parts?.length ?? 0);) {
      signal?.throwIfAborted();
      delivery.status = "sending";
      await this.storage.put(key, delivery);
      try {
        const bot = new TelegramBot(requiredSecret(this.token, "TELEGRAM_BOT_TOKEN"));
        const part = delivery.parts![delivery.nextPart]!;
        const replyTo = delivery.nextPart === 0 ? this.job.retry?.replyTo ?? this.job.replyTo : undefined;
        let id: number;
        if (typeof part === "string") id = await bot.send(this.job.chatId, part, replyTo, signal);
        else {
          const sent = await bot.publish(this.job.chatId, part, replyTo, signal, delivery.editId, delivery.format);
          id = sent.messageId;
          delivery.format = sent.format;
        }
        (delivery.sentIds ??= []).push(id);
        delivery.nextPart++;
        delivery.status = "ready";
        delivery.retryAt = undefined;
        await this.storage.put(key, delivery);
      } catch (error) {
        delivery.deliveryAttempts++;
        if (error instanceof TelegramError && error.retryable && delivery.deliveryAttempts < 5) {
          delivery.status = "ready";
          delivery.retryAt = Date.now() + error.retryAfter * 1000;
        } else {
          delivery.status = "failed";
          delivery.error = error instanceof TelegramError && error.uncertain ? "telegram_delivery_uncertain" : "telegram_delivery_failed";
        }
        await this.storage.put(key, delivery);
        return;
      }
    }
    delivery.status = delivery.error ? "failed" : "complete";
    await this.storage.put(key, delivery);
  }

  private async flush(key: string, delivery: TextDelivery, signal: AbortSignal) {
    while (delivery.status !== "complete") {
      signal.throwIfAborted();
      if (delivery.status === "failed") throw new TelegramError(0, false, delivery.error === "telegram_delivery_uncertain");
      if (delivery.retryAt && delivery.retryAt > Date.now()) await scheduler.wait(delivery.retryAt - Date.now(), { signal });
      await this.deliver(key, delivery, signal);
    }
  }

  private async send(key: string, view: TelegramView, revision: number, signal: AbortSignal) {
    if (this.job.chatId === undefined) return;
    let delivery = await this.storage.get<TextDelivery>(key);
    if (delivery) {
      await this.flush(key, delivery, signal);
      if ((delivery.revision ?? 0) >= revision) return;
      const previous = delivery.parts?.[0];
      // Completion events do not carry arguments; keep the actual validated execution arguments.
      if (view.type === "tool" && view.status !== "running" && typeof previous === "object" && previous.type === "tool") view = { ...view, args: previous.args };
      if (JSON.stringify(previous) === JSON.stringify(view)) {
        delivery.revision = revision;
        await this.storage.put(key, delivery);
        return;
      }
    }
    if (view.type !== "tool" && !view.text.trim()) return;
    delivery = { status: "ready", parts: [view], nextPart: 0, deliveryAttempts: 0, revision, ...(delivery ? { editId: delivery.sentIds![0]!, format: delivery.format } : {}) };
    await this.flush(key, delivery, signal);
  }

  private thinkingKey(after: number, messageIndex: number, contentIndex: number): string {
    // The preceding assistant entry is stable across partials, final commits, retries and restart replay.
    return `thinking:${this.job.id}:${after}:${messageIndex}:${contentIndex}`;
  }

  async partial(message: AssistantMessage, after: number, revision: number, signal: AbortSignal) {
    for (const [index, block] of message.content.entries()) {
      // Later thinking must not overtake preceding public text or tool calls.
      if (block.type !== "thinking") break;
      if (!block.thinking) continue;
      const key = this.thinkingKey(after, 0, index);
      const now = Date.now();
      if (now - (this.progressAt.get(key) ?? 0) < 2000) continue;
      this.progressAt.set(key, now);
      await this.send(key, { type: "thinking", text: activityEvidence(block.thinking, true) }, revision, signal);
    }
  }

  async entry(entry: EntryRecord, after: number, signal: AbortSignal) {
    if (entry.kind === ToolResultEntry.kind) {
      for (const message of entry.model ?? []) {
        if (message.role === "toolResult") await this.toolStatus(`${after}:${message.toolCallId}`, message.isError ? "failed" : "done", signal);
      }
      return;
    }
    if (entry.kind !== AssistantEntry.kind || this.job.chatId === undefined) return;
    const key = `assistant:${entry.id}`;
    let marker = await this.storage.get<TextDelivery>(key);
    if (marker && marker.presentation !== "blocks") { await this.flush(key, marker, signal); return; }
    for (const [messageIndex, message] of (entry.model ?? []).entries()) {
      if (message.role !== "assistant") continue;
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      for (const [index, block] of message.content.entries()) {
        if (block.type === "toolCall") this.tools.set(`${entry.id}:${block.id}`, { key: `${key}:${messageIndex}:${index}`, view: { type: "tool", name: activityEvidence(block.name), args: activityEvidence(JSON.stringify(block.arguments, null, 2)), status: "requested" } });
      }
    }
    if (marker?.status === "complete") return;
    marker ??= { status: "running", presentation: "blocks", nextPart: 0, deliveryAttempts: 0 };
    await this.storage.put(key, marker);
    for (const [messageIndex, message] of (entry.model ?? []).entries()) {
      if (message.role !== "assistant") continue;
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      if (!["stop", "toolUse"].includes(message.stopReason)) await this.send(`${key}:${messageIndex}:status`, { type: "text", text: `(stopReason: "${message.stopReason}")` }, 0, signal);
      if (!message.content.length || message.content.every(block => block.type === "text" && !block.text)) await this.send(`${key}:${messageIndex}:empty`, { type: "text", text: "（空回复）" }, 0, signal);
      for (const [index, block] of message.content.entries()) {
        switch (block.type) {
          case "thinking":
            if (block.thinking) await this.send(this.thinkingKey(after, messageIndex, index), { type: "thinking", text: activityEvidence(block.thinking, true) }, Number.MAX_SAFE_INTEGER, signal);
            break;
          case "text":
            // shortcut: long Markdown is split by code point; rejected Rich chunks fall back to literal HTML.
            for (const [part, text] of replyParts(block.text).entries()) await this.send(`${key}:${messageIndex}:${index}:${part}`, { type: "text", text }, 0, signal);
            break;
          case "toolCall": {
            const tool = this.tools.get(`${entry.id}:${block.id}`)!;
            await this.send(tool.key, tool.view, 1, signal);
            break;
          }
        }
      }
    }
    marker.status = "complete";
    await this.storage.put(key, marker);
  }

  private async toolStatus(id: string, status: "done" | "failed", signal: AbortSignal) {
    const tool = this.tools.get(id);
    if (tool) await this.send(tool.key, { ...tool.view, status }, 3, signal);
  }

  async task(task: TaskRecord<JsonValue, JsonValue, JsonValue>, signal: AbortSignal) {
    if (task.kind !== "pi.tool") return;
    const input = task.input as ToolTaskInput;
    if (input.kind !== "model") return;
    const key = `${input.assistant}:${input.callId}`;
    const tool = this.tools.get(key);
    if (!tool) return;
    const checkpoint = task.state.status === "terminal" ? undefined : task.state.checkpoint as ToolTaskCheckpoint | undefined;
    if (task.state.status === "running" && checkpoint?.phase === "execute") {
      tool.view = { ...tool.view, args: activityEvidence(JSON.stringify(checkpoint.arguments, null, 2)), status: "running" };
      await this.send(tool.key, tool.view, 2, signal);
    } else if (task.state.status === "terminal" && task.state.outcome.status !== "completed") await this.toolStatus(key, "failed", signal);
  }
}
