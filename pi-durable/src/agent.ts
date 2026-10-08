import { AgentFiles } from "./bash/files.js";
import { bashExtension } from "./bash/extension.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, createRegistry, defineExtension, defineTool, section, type CompactionResult, type TaskId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Env } from "./env.js";
import { ownerId, requiredSecret } from "./env.js";
import { HttpError, errorResponse, jsonBody, textField } from "./http.js";
import { MemoryStore } from "./memory/store.js";
import { memoryExtension, toolText } from "./memory/extension.js";
import { openAgentStorage } from "./pi/storage.js";
import { openRouterModels, type AgentModels } from "./pi/models.js";
import { TelegramBot, TelegramError, splitTelegramText } from "./telegram.js";
import { WebAccess } from "./web/access.js";
import { webExtension } from "./web/extension.js";
import { SpeechDelivery, type SpeechReceipt } from "./speech/delivery.js";
import { speechExtension } from "./speech/extension.js";

const JOB_TIMEOUT_MS = 120_000;
const CONTEXT = BACKGROUND_CONTEXT;

export interface Job {
  id: string;
  requestId: string;
  kind: "user" | "wakeup" | "compact";
  input: string;
  chatId?: number;
  replyTo?: number;
  sequence: number;
  createdAt: number;
  status: "pending" | "running" | "ready" | "sending" | "complete" | "failed";
  parts?: string[];
  sentIds?: number[];
  nextPart: number;
  deliveryAttempts: number;
  retryAt?: number;
  error?: string;
  submissionId?: number;
  compactionTaskId?: TaskId<CompactionResult>;
}

export interface Wakeup {
  id: string;
  active: boolean;
  startedAt: number;
  deadline: number;
  nextAt: number;
  intervalMs: number;
  sequence: number;
  startedSequence: number;
  confirmedAt?: number;
  lastUserAt?: number;
  lastUserSequence?: number;
}

async function jobId(requestId: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requestId));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const wakeupPrompt = "这是唤醒提醒，不是用户输入。请发送一两行简短中文提醒，措辞自然且不要重复。只有用户明确表现已经清醒时才调用 wakeup_confirm；困倦或含糊回答不能视为确认。";

export class AgentBackend extends AgentFiles {
  declare protected env: Env;
  private draining?: Promise<void>;
  private currentJob?: Job;
  private readonly memory: MemoryStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const base = env.MEMORY_PREFIX ?? "hermes/";
    this.memory = new MemoryStore(ctx.storage, `${base.replace(/\/$/, "")}/${ownerId(env)}/`, this);
  }

  protected modelRuntime(): AgentModels { return openRouterModels(this.env); }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/enqueue" && request.method === "POST") {
        const body = await jsonBody(request);
        const requestId = textField(body.requestId, "requestId", 200);
        const input = textField(body.input, "input", 8_000);
        const chatId = body.chatId === undefined ? undefined : Number(body.chatId);
        if (chatId !== undefined && chatId !== Number(ownerId(this.env))) throw new HttpError(403, "Invalid chat");
        const replyTo = body.replyTo === undefined ? undefined : Number(body.replyTo);
        if (replyTo !== undefined && (!Number.isSafeInteger(replyTo) || replyTo < 1)) throw new HttpError(400, "Invalid reply message");
        const job = await this.enqueue({ requestId, input, kind: input.trim() === "/compact" ? "compact" : "user", chatId, replyTo });
        this.ctx.waitUntil(this.drain());
        return Response.json({ id: job.id, status: job.status }, { status: 202 });
      }
      if (url.pathname === "/wakeup" && request.method === "POST") {
        const now = Date.now();
        const wakeup: Wakeup = { id: crypto.randomUUID(), active: true, startedAt: now, deadline: now + 360 * 60_000, nextAt: now, intervalMs: 120_000, sequence: 0, startedSequence: 0 };
        const accepted = await this.ctx.storage.transaction(async (storage) => {
          const existing = await storage.get<Wakeup>("wakeup");
          if (existing?.active && existing.deadline > now) return existing;
          wakeup.startedSequence = (await storage.get<number>("sequence")) ?? 0;
          await storage.put("wakeup", wakeup);
          await storage.setAlarm(now);
          return wakeup;
        });
        this.ctx.waitUntil(this.drain());
        return Response.json(accepted, { status: 202 });
      }
      throw new HttpError(404, "Not found");
    } catch (error) { return errorResponse(error); }
  }

  private pendingKey(sequence: number): string { return `pending:${String(sequence).padStart(16, "0")}`; }

  private async enqueue(input: Pick<Job, "requestId" | "kind" | "input" | "chatId" | "replyTo">): Promise<Job> {
    const id = await jobId(input.requestId);
    return this.ctx.storage.transaction((storage) => this.admit(storage, input, id));
  }

  private async admit(storage: DurableObjectTransaction, input: Pick<Job, "requestId" | "kind" | "input" | "chatId" | "replyTo">, id: string): Promise<Job> {
      const existing = await storage.get<Job>(`job:${id}`);
      if (existing) {
        if (existing.input !== input.input || existing.chatId !== input.chatId || existing.replyTo !== input.replyTo || existing.kind !== input.kind) throw new HttpError(409, "requestId already has different input");
        return existing;
      }
      const pending = await storage.list({ prefix: "pending:", limit: 65 });
      if (pending.size >= 64) throw new HttpError(429, "Agent queue is full");
      const sequence = ((await storage.get<number>("sequence")) ?? 0) + 1;
      const job: Job = { ...input, id, sequence, createdAt: Date.now(), status: "pending", nextPart: 0, deliveryAttempts: 0 };
      await storage.put({ [`job:${id}`]: job, [this.pendingKey(sequence)]: id, sequence });
      if (input.kind !== "wakeup") {
        const wakeup = await storage.get<Wakeup>("wakeup");
        if (wakeup?.active) { wakeup.lastUserAt = Date.now(); wakeup.lastUserSequence = sequence; wakeup.nextAt = wakeup.lastUserAt + wakeup.intervalMs; await storage.put("wakeup", wakeup); }
      }
      await storage.setAlarm(Date.now());
      return job;
  }

  private registry(store: MemoryStore, job: Job) {
    const registry = createRegistry();
    registry.install(memoryExtension(store));
    registry.install(bashExtension(this, `/${store.prefix.slice(0, -1)}`));
    registry.install(webExtension(new WebAccess(this.env)));
    // Scheduled reminders do not load speech tools or their prompt section.
    if (job.kind === "user") {
      const key = `speech:${job.id}`;
      registry.install(speechExtension(new SpeechDelivery(this.env, {
        claim: (candidate) => this.ctx.storage.transaction(async storage => {
          const existing = await storage.get<SpeechReceipt>(key);
          if (!existing) await storage.put(key, candidate);
          return existing;
        }),
        save: (receipt) => this.ctx.storage.put(key, receipt),
      }), job.replyTo));
    }
    registry.install(defineExtension({
      name: "telegram-agent",
      sections: [
        section("identity", () => "你是用户的私人中文助手，运行在 Cloudflare Workers。使用长期文本记忆与持久化 Skills、虚拟 bash、公开网页工具帮助用户。读取相关 Skill 后再使用可用工具；本环境没有真实 shell、Node 子进程、ffmpeg 或宿主文件系统。不能执行的步骤要如实说明。优先简洁回答；每个请求尽量不超过 8 次工具调用。最终回答会自动发送到 Telegram，不要重复发送。不要披露或尝试读取部署密钥。只记录用户明确确认且值得长期保留的事实，重要纠正应更新记忆。"),
        section("wakeup_status", async () => {
          const wakeup = await this.ctx.storage.get<Wakeup>("wakeup");
          return wakeup?.active ? "当前正在唤醒用户。含糊、困倦或没有明确表示清醒的回答不能确认；用户确实清醒后调用 wakeup_confirm，再正常回应。" : undefined;
        }),
      ],
      tools: [defineTool({
        name: "wakeup_confirm", description: "仅当本轮用户的真实回复明确表明已经清醒时停止唤醒提醒。不能根据内部定时提醒确认。",
        parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 300 }) }),
        execute: () => this.ctx.storage.transaction(async (storage) => {
          const wakeup = await storage.get<Wakeup>("wakeup");
          if (!wakeup?.active) return toolText({ active: false });
          if (this.currentJob?.kind !== "user" || this.currentJob.sequence <= wakeup.startedSequence) return { ...toolText({ error: "No new user reply can confirm wakefulness" }), isError: true };
          wakeup.active = false;
          wakeup.confirmedAt = Date.now();
          await storage.put("wakeup", wakeup);
          return toolText({ active: false, confirmed: true });
        }),
      })],
    }));
    return registry;
  }

  private async answer(job: Job): Promise<void> {
    const { models, model } = this.modelRuntime();
    const store = this.memory;
    const harness = await Harness.open(await openAgentStorage(this.ctx.storage), {
      models, registry: this.registry(store, job),
      settings: { toolExecution: "sequential", stream: { timeoutMs: 60_000, maxRetries: 0 }, retry: { maxRetries: 1, baseDelayMs: 1000 }, progress: { partialIntervalMs: 1000, outputIntervalMs: 1000 } },
      onReport: () => console.error("Pi Durable reported an internal task error"),
    }, CONTEXT);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let root: Awaited<ReturnType<typeof harness.root>> | undefined;
    try {
      root = await harness.root(CONTEXT, { agent: { model } });
      await root.configure({ model }, CONTEXT);
      const reply = await Promise.race([
        (async () => {
          if (job.kind === "compact") {
            if (job.compactionTaskId === undefined) {
              // ponytail: a crash between task creation and saving its ID can repeat summarization.
              job.compactionTaskId = await root.compact(undefined, CONTEXT);
              await this.ctx.storage.put(`job:${job.id}`, job);
            }
            const { outcome } = (await harness.waitForTask(job.compactionTaskId, CONTEXT)).state;
            if (outcome.status !== "completed") throw new Error("Compaction did not complete");
            if (outcome.result.submissionId === undefined) return "当前上下文较短，无需压缩。";
            const placement = await harness.submission(outcome.result.submissionId, CONTEXT);
            if (!placement || (await placement.wait(CONTEXT)).status !== "done") throw new Error("Compaction summary was not placed");
            return "上下文已压缩，历史记录和记忆文件已保留。";
          }
          const submission = await root.submit({ type: "input", content: job.input, requestId: job.requestId }, CONTEXT);
          job.submissionId = submission.id;
          await this.ctx.storage.put(`job:${job.id}`, job);
          const settled = await submission.wait(CONTEXT);
          if (settled.status !== "done" || settled.type !== "input") throw new Error("Agent submission was not answered");
          const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), CONTEXT);
          const text = entry?.model?.flatMap((message) => message.role === "assistant" ? message.content.flatMap((block) => block.type === "text" ? [block.text] : []) : []).join("\n").trim();
          return text || "已处理。";
        })(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Agent job timed out")), JOB_TIMEOUT_MS); }),
      ]);
      let truncated = reply.slice(0, 20_000);
      if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1);
      job.parts = splitTelegramText(truncated);
      job.status = "ready";
      await this.ctx.storage.put(`job:${job.id}`, job);
    } catch (error) {
      // A timed-out run must not resume later under a different user job.
      await root?.abort(CONTEXT).catch(() => {});
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      await harness.close(CONTEXT);
    }
  }

  private async finish(job: Job): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => { await storage.put(`job:${job.id}`, job); await storage.delete(this.pendingKey(job.sequence)); });
  }

  private async process(job: Job): Promise<void> {
    if (job.status === "complete" || job.status === "failed") { await this.finish(job); return; }
    if (job.status === "sending") {
      // A crash after sendMessage may have delivered the message. Never blindly
      // resend an ambiguous part: Telegram has no outgoing idempotency key.
      job.status = "failed"; job.error = "telegram_delivery_uncertain"; await this.finish(job); return;
    }
    if (job.retryAt && job.retryAt > Date.now()) return;
    if (job.kind === "wakeup" && job.status === "pending") {
      const wakeup = await this.ctx.storage.get<Wakeup>("wakeup");
      if (!wakeup?.active || !job.requestId.startsWith(`wakeup:${wakeup.id}:`) || wakeup.deadline <= Date.now() || (wakeup.lastUserSequence ?? 0) > job.sequence) {
        job.status = "complete"; await this.finish(job); return;
      }
    }
    this.currentJob = job;
    try {
      if (job.status === "pending" || job.status === "running") {
        job.status = "running";
        await this.ctx.storage.put(`job:${job.id}`, job);
        try { await this.answer(job); }
        catch {
          job.error = job.kind === "compact" ? "compaction_failed" : "agent_generation_failed";
          job.parts = [job.kind === "compact" ? "上下文压缩未完成，请稍后重试；历史记录和记忆文件未删除。" : "这次处理失败了，可能是模型配置、网络或执行超时。请稍后重试；已保存的记忆不会丢失。"];
          job.status = "ready";
          await this.ctx.storage.put(`job:${job.id}`, job);
        }
      }
      if (job.kind === "wakeup") {
        const wakeup = await this.ctx.storage.get<Wakeup>("wakeup");
        if (!wakeup?.active || !job.requestId.startsWith(`wakeup:${wakeup.id}:`) || wakeup.deadline <= Date.now() || (wakeup.lastUserSequence ?? 0) > job.sequence) { job.status = "complete"; await this.finish(job); return; }
      }
      if (job.chatId !== undefined) {
        const bot = new TelegramBot(requiredSecret(this.env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN"));
        for (; job.nextPart < (job.parts?.length ?? 0);) {
          job.status = "sending";
          await this.ctx.storage.put(`job:${job.id}`, job);
          try {
            const id = await bot.send(job.chatId, job.parts![job.nextPart]!, job.nextPart === 0 ? job.replyTo : undefined);
            (job.sentIds ??= []).push(id);
            job.nextPart++;
            job.status = "ready";
            job.retryAt = undefined;
            await this.ctx.storage.put(`job:${job.id}`, job);
          } catch (error) {
            job.deliveryAttempts++;
            if (error instanceof TelegramError && error.retryable && job.deliveryAttempts < 5) {
              job.status = "ready";
              job.retryAt = Date.now() + error.retryAfter * 1000;
              await this.ctx.storage.put(`job:${job.id}`, job);
            } else {
              job.status = "failed";
              job.error = error instanceof TelegramError && error.uncertain ? "telegram_delivery_uncertain" : "telegram_delivery_failed";
              await this.finish(job);
            }
            return;
          }
        }
      }
      job.status = job.error ? "failed" : "complete";
      await this.finish(job);
    } finally { this.currentJob = undefined; }
  }

  private async nextJob(): Promise<Job | undefined> {
    const pending = await this.ctx.storage.list<string>({ prefix: "pending:", limit: 1 });
    const id = pending.values().next().value as string | undefined;
    if (!id) return undefined;
    const job = await this.ctx.storage.get<Job>(`job:${id}`);
    if (!job) throw new Error("Queue references a missing job");
    return job;
  }

  private async nudge(): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      if ((await storage.list({ prefix: "pending:", limit: 1 })).size) return;
      const wakeup = await storage.get<Wakeup>("wakeup");
      if (!wakeup?.active) return;
      if (wakeup.deadline <= Date.now()) { wakeup.active = false; await storage.put("wakeup", wakeup); return; }
      if (wakeup.nextAt > Date.now()) return;
      const input = { requestId: `wakeup:${wakeup.id}:${wakeup.sequence}`, kind: "wakeup" as const, input: wakeupPrompt, chatId: Number(ownerId(this.env)) };
      await this.admit(storage, input, await jobId(input.requestId));
      wakeup.sequence++;
      wakeup.nextAt = Date.now() + wakeup.intervalMs;
      await storage.put("wakeup", wakeup);
    });
  }

  private async schedule(): Promise<void> {
    // Admission and alarm updates share a transaction; an idle drain cannot
    // delete an alarm installed by a concurrently arriving Telegram update.
    await this.ctx.storage.transaction(async (storage) => {
      const queue = await storage.list<string>({ prefix: "pending:", limit: 1 });
      const id = queue.values().next().value as string | undefined;
      const pending = id ? await storage.get<Job>(`job:${id}`) : undefined;
      const wakeup = await storage.get<Wakeup>("wakeup");
      if (pending) await storage.setAlarm(Math.max(Date.now() + 1000, pending.retryAt ?? 0));
      else if (wakeup?.active) await storage.setAlarm(Math.max(Date.now() + 1000, Math.min(wakeup.nextAt, wakeup.deadline)));
      else await storage.deleteAlarm();
    });
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    const running = (async () => {
      try {
        if (!(await this.nextJob())) await this.nudge();
        const job = await this.nextJob();
        if (job) await this.process(job);
      } finally { await this.schedule(); }
    })();
    this.draining = running;
    void running.finally(() => { if (this.draining === running) this.draining = undefined; }).catch(() => {});
    return running;
  }

  async alarm(): Promise<void> { await this.drain(); }
}
