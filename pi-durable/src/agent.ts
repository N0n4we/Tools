import { AgentFiles } from "./bash/files.js";
import { bashExtension } from "./bash/extension.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, LiveDoc, ToolResultEntry, createRegistry, defineExtension, section, type CompactionResult, type Conversation, type Cursor, type EntryId, type EntryRecord, type LiveState, type Registry, type Submission, type TaskId } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Env } from "./env.js";
import { ownerId } from "./env.js";
import { HttpError, errorResponse, jsonBody, textField } from "./http.js";
import { MemoryStore } from "./memory/store.js";
import { memoryExtension } from "./memory/extension.js";
import { discardAgentSession, openAgentStorage } from "./pi/storage.js";
import { openRouterModels, type AgentModels } from "./pi/models.js";
import { TelegramError } from "./telegram.js";
import { TelegramOutput, replyParts, type TextDelivery } from "./telegram-output.js";
import { WebAccess } from "./web/access.js";
import { webExtension } from "./web/extension.js";
import { SpeechDelivery, type SpeechReceipt } from "./speech/delivery.js";
import { speechExtension } from "./speech/extension.js";
import { installSpeechSkill } from "./speech/skill.js";

const JOB_TIMEOUT_MS = 6 * 60 * 60_000;
const CONTEXT = BACKGROUND_CONTEXT;

export interface Job extends TextDelivery {
  id: string;
  requestId: string;
  kind: "user" | "scheduled" | "compact" | "new";
  input: string;
  chatId?: number;
  replyTo?: number;
  sequence: number;
  createdAt: number;
  submissionId?: number;
  compactionTaskId?: TaskId<CompactionResult>;
  outputAfter?: EntryId | null;
}

async function jobId(requestId: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requestId));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class AgentBackend extends AgentFiles {
  declare protected env: Env;
  private draining?: Promise<void>;
  private active?: { root: Conversation; registry: Registry; jobId: string; steers: Map<string, Promise<{ job: Job; submission: Submission }>> };
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
        if (body.kind !== undefined && body.kind !== "scheduled") throw new HttpError(400, "Invalid job kind");
        const chatId = body.chatId === undefined ? undefined : Number(body.chatId);
        if (chatId !== undefined && chatId !== Number(ownerId(this.env))) throw new HttpError(403, "Invalid chat");
        const replyTo = body.replyTo === undefined ? undefined : Number(body.replyTo);
        if (replyTo !== undefined && (!Number.isSafeInteger(replyTo) || replyTo < 1)) throw new HttpError(400, "Invalid reply message");
        const command = input.trim();
        const kind = body.kind === "scheduled" ? "scheduled" : command === "/compact" ? "compact" : command === "/new" ? "new" : "user";
        const job = await this.enqueue({ requestId, input, kind, chatId, replyTo });
        this.ctx.waitUntil(this.drain());
        return Response.json({ id: job.id, status: job.status }, { status: 202 });
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
      await storage.setAlarm(Date.now());
      return job;
  }

  private registry(store: MemoryStore, job: Job) {
    const registry = createRegistry();
    const web = new WebAccess(this.env);
    registry.install(memoryExtension(store));
    registry.install(bashExtension(this, `/${store.prefix.slice(0, -1)}`, web));
    registry.install(webExtension(web));
    this.installSpeech(registry, job);
    registry.install(defineExtension({
      name: "telegram-agent",
      sections: [
        section("current_time", () => `当前时间（Asia/Shanghai，UTC+8）：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`),
      ],
    }));
    return registry;
  }

  private installSpeech(registry: Registry, job: Job) {
    if (job.kind !== "user") return;
    installSpeechSkill(this.ctx.storage, this, this.memory.prefix);
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

  private async steerPending() {
    const active = this.active;
    if (!active) return;
    for (const id of (await this.ctx.storage.list<string>({ prefix: "pending:", limit: 65 })).values()) {
      const job = await this.ctx.storage.get<Job>(`job:${id}`);
      if (this.active !== active) return;
      if (job?.kind === "new") break;
      if (!job || job.id === active.jobId || job.kind !== "user" || job.status !== "pending" || active.steers.has(id)) continue;
      const forwarded = (async () => {
        this.installSpeech(active.registry, job);
        const submission = await active.root.submit({ type: "input", content: job.input, requestId: job.requestId, whenBusy: "steer" }, CONTEXT);
        job.submissionId = submission.id;
        await this.ctx.storage.put(`job:${id}`, job);
        return { job, submission };
      })();
      active.steers.set(id, forwarded);
      await forwarded;
    }
  }

  private async ready(job: Job, reply: string) {
    job.parts = replyParts(reply);
    job.status = "ready";
    await this.ctx.storage.put(`job:${job.id}`, job);
  }

  private async answer(job: Job, output: TelegramOutput): Promise<void> {
    if (job.createdAt + JOB_TIMEOUT_MS <= Date.now()) throw new Error("Agent job timed out");
    if (job.kind === "new") {
      await this.ctx.storage.transaction(async storage => {
        discardAgentSession(this.ctx.storage.sql);
        job.parts = ["已开始新会话，旧会话记录已丢弃；记忆和 Skill 文件已保留。"];
        job.status = "ready";
        await storage.put(`job:${job.id}`, job);
      });
      return;
    }
    const { models, model } = this.modelRuntime();
    const store = this.memory;
    const registry = this.registry(store, job);
    const harness = await Harness.open(await openAgentStorage(this.ctx.storage), {
      models, registry,
      settings: {
        toolExecution: "sequential", steeringMode: "all", stream: { timeoutMs: 60_000, maxRetries: 0 }, retry: { maxRetries: 1, baseDelayMs: 1000 }, progress: { partialIntervalMs: 1000, outputIntervalMs: 1000 },
        compaction: job.kind === "compact" ? { keepRecentTokens: 0 } : undefined,
      },
      onReport: () => console.error("Pi Durable reported an internal task error"),
    }, CONTEXT);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let root: Awaited<ReturnType<typeof harness.root>> | undefined;
    let unsubscribe: (() => void) | undefined;
    let forwarding = Promise.resolve();
    const outputAbort = new AbortController();
    let rejectOutput!: (error: unknown) => void;
    const outputFailure = new Promise<never>((_, reject) => { rejectOutput = reject; });
    const enqueueOutput = (send: () => Promise<void>) => {
      forwarding = forwarding.then(send);
      void forwarding.catch(rejectOutput);
    };
    let after = job.outputAfter ?? 0;
    const seen = new Set<EntryId>();
    const forward = (entry: EntryRecord) => {
      if ((entry.kind !== AssistantEntry.kind && entry.kind !== ToolResultEntry.kind) || seen.has(entry.id)) return;
      seen.add(entry.id);
      const previous = after;
      if (entry.kind === AssistantEntry.kind) after = entry.id;
      enqueueOutput(() => output.entry(entry, previous, outputAbort.signal));
    };
    try {
      root = await harness.root(CONTEXT, { agent: { model } });
      await root.configure({ model, thinkingLevel: "medium" }, CONTEXT);
      const reply = await Promise.race([
        (async () => {
          if (job.kind === "compact") {
            if (job.compactionTaskId === undefined) {
              // ponytail: a crash between task creation and saving its ID can repeat summarization.
              job.compactionTaskId = await root.compact(undefined, CONTEXT);
              await this.ctx.storage.put(`job:${job.id}`, job);
            }
            const { outcome } = (await harness.waitForTask(job.compactionTaskId, CONTEXT)).state;
            if (outcome.status !== "completed") throw new Error(outcome.error?.message ?? outcome.status);
            if (outcome.result.submissionId === undefined) return "当前没有可压缩的历史内容。";
            const placement = await harness.submission(outcome.result.submissionId, CONTEXT);
            if (!placement || (await placement.wait(CONTEXT)).status !== "done") throw new Error("Compaction summary was not placed");
            return "上下文已压缩，历史记录和记忆文件已保留。";
          }
          if (job.outputAfter === undefined) {
            job.outputAfter = (await root.entries({}, 1, undefined, CONTEXT)).items[0]?.id ?? null;
            await this.ctx.storage.put(`job:${job.id}`, job);
          }
          after = job.outputAfter ?? 0;
          const conversationId = root.id;
          // Replay committed output before submit resumes durable tasks; entry IDs deduplicate delivery.
          const recovered: EntryRecord[] = [];
          let cursor: Cursor | undefined;
          do {
            const page = await root.entries({ minEntryId: job.outputAfter ?? undefined }, 100, cursor, CONTEXT);
            recovered.push(...page.items.filter(entry => entry.id > (job.outputAfter ?? 0)));
            cursor = page.next;
          } while (cursor);
          recovered.reverse().forEach(forward);
          // Faulted/orphaned tools can end without a result entry, including while the process was down.
          if (recovered.some(entry => entry.kind === AssistantEntry.kind)) {
            let taskCursor: Cursor | undefined;
            do {
              const page = await root.commit(tx => tx.scanTasks({ conversationId, kind: "pi.tool", order: "descending" }, 100, taskCursor), CONTEXT);
              for (const task of page.items) if (task.id > (job.outputAfter ?? 0)) enqueueOutput(() => output.task(task, outputAbort.signal));
              taskCursor = page.items.every(task => task.id > (job.outputAfter ?? 0)) ? page.next : undefined;
            } while (taskCursor);
          }
          unsubscribe = harness.subscribeCommits(({ changes, seq }) => {
            const entries = changes.flatMap(change => change.type === "entry" && change.value.conversationId === conversationId ? [change.value] : []);
            entries.sort((a, b) => a.id - b.id).forEach(forward);
            for (const change of changes) {
              if (change.type === "task" && change.value.conversationId === conversationId && change.value.kind === "pi.tool") enqueueOutput(() => output.task(change.value, outputAbort.signal));
              if (change.type === "document" && change.conversationId === conversationId && change.record.kind === LiveDoc.definition.kind) {
                const live = change.value as LiveState | null;
                const message = live?.generation?.message as AssistantMessage | undefined;
                const previous = after;
                if (message) enqueueOutput(() => output.partial(message, previous, seq, outputAbort.signal));
              }
            }
          });
          const submission = await root.submit({ type: "input", content: job.input, requestId: job.requestId }, CONTEXT);
          job.submissionId = submission.id;
          await this.ctx.storage.put(`job:${job.id}`, job);
          const active: NonNullable<AgentBackend["active"]> = { root, registry, jobId: job.id, steers: new Map() };
          this.active = active;
          await this.steerPending();
          const settled = await submission.wait(CONTEXT);
          if (settled.status !== "done") throw new Error(String(settled.detail ?? settled.reason));
          if (settled.type !== "input") throw new Error(String(settled.detail ?? settled.type));
          const answers = new Set([settled.answer]);
          const steeredJobs: Job[] = [];
          for (const forwarded of active.steers.values()) {
            const { job: steered, submission } = await forwarded;
            const result = await submission.wait(CONTEXT);
            if (result.status !== "done") throw new Error(String(result.detail ?? result.reason));
            if (result.type !== "input") throw new Error(String(result.detail ?? result.type));
            answers.add(result.answer);
            steeredJobs.push(steered);
          }
          this.active = undefined;
          for (const answer of answers) {
            const entry = await root.commit(tx => tx.entry(AssistantEntry, answer), CONTEXT);
            if (!entry) throw new Error("Agent answer is missing");
            forward(entry);
          }
          unsubscribe();
          unsubscribe = undefined;
          await forwarding;
          outputAbort.signal.throwIfAborted();
          for (const steered of steeredJobs) {
            steered.status = "complete";
            await this.finish(steered);
          }
        })(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => {
          const error = new Error("Agent job timed out");
          outputAbort.abort(error);
          reject(error);
        }, Math.max(1, job.createdAt + JOB_TIMEOUT_MS - Date.now())); }),
        outputFailure,
      ]);
      if (reply !== undefined) await this.ready(job, reply);
    } catch (error) {
      // A timed-out run must not resume later under a different user job.
      this.active = undefined;
      unsubscribe?.();
      if (error instanceof TelegramError) outputAbort.abort(error);
      await root?.abort(CONTEXT).catch(() => {});
      await forwarding;
      throw error;
    } finally {
      this.active = undefined;
      unsubscribe?.();
      outputAbort.abort();
      if (timeout) clearTimeout(timeout);
      await harness.close(CONTEXT);
    }
  }

  private async finish(job: Job): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => { await storage.put(`job:${job.id}`, job); await storage.delete(this.pendingKey(job.sequence)); });
  }

  private async process(job: Job): Promise<void> {
    if (job.status === "complete" || job.status === "failed") { await this.finish(job); return; }
    if (job.retryAt && job.retryAt > Date.now()) return;
    const output = new TelegramOutput(this.ctx.storage, this.env.TELEGRAM_BOT_TOKEN, job);
    if (job.status === "pending" || job.status === "running") {
      job.status = "running";
      await this.ctx.storage.put(`job:${job.id}`, job);
      try { await this.answer(job, output); }
      catch (error) {
        if (error instanceof TelegramError) {
          job.status = "failed";
          job.error = error.uncertain ? "telegram_delivery_uncertain" : "telegram_delivery_failed";
          await this.finish(job);
          return;
        }
        job.error = job.kind === "compact" ? "compaction_failed" : job.kind === "new" ? "session_reset_failed" : "agent_generation_failed";
        job.parts = [error instanceof Error ? error.message : String(error)];
        job.status = "ready";
        await this.ctx.storage.put(`job:${job.id}`, job);
      }
    }
    if (job.chatId !== undefined) await output.deliver(`job:${job.id}`, job);
    else job.status = job.error ? "failed" : "complete";
    if (job.status === "complete" || job.status === "failed") await this.finish(job);
  }

  private async nextJob(): Promise<Job | undefined> {
    const pending = await this.ctx.storage.list<string>({ prefix: "pending:", limit: 1 });
    const id = pending.values().next().value as string | undefined;
    if (!id) return undefined;
    const job = await this.ctx.storage.get<Job>(`job:${id}`);
    if (!job) throw new Error("Queue references a missing job");
    return job;
  }

  private async schedule(): Promise<void> {
    // Admission and alarm updates share a transaction; an idle drain cannot
    // delete an alarm installed by a concurrently arriving Telegram update.
    await this.ctx.storage.transaction(async (storage) => {
      const queue = await storage.list<string>({ prefix: "pending:", limit: 1 });
      const id = queue.values().next().value as string | undefined;
      const pending = id ? await storage.get<Job>(`job:${id}`) : undefined;
      if (pending) await storage.setAlarm(Math.max(Date.now() + (pending.status === "running" ? 60_000 : 1000), pending.retryAt ?? 0));
      else await storage.deleteAlarm();
    });
  }

  private drain(): Promise<void> {
    if (this.draining) {
      const running = this.draining;
      return this.steerPending().then(() => running);
    }
    const running = (async () => {
      try {
        const job = await this.nextJob();
        if (job) await this.process(job);
      } finally { await this.schedule(); }
    })();
    this.draining = running;
    void running.finally(() => { if (this.draining === running) this.draining = undefined; }).catch(() => {});
    return running;
  }

  async alarm(): Promise<void> {
    // Keep only the generic queue recovery alarm; task timing belongs to Pi's bash calls.
    await this.schedule();
    this.ctx.waitUntil(this.drain());
  }
}
