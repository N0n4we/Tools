import { AgentFiles } from "./bash/files.js";
import { bashExtension } from "./bash/extension.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, GenerationTask, Harness, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID, ToolResultEntry, UserEntry, createRegistry, type CompactionResult, type Conversation, type Cursor, type EntryId, type EntryRecord, type LiveState, type Registry, type Submission, type TaskId } from "@earendil-works/pi-durable";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Env } from "./env.js";
import { ownerId } from "./env.js";
import { HttpError, errorResponse, jsonBody, textField } from "./http.js";
import { MemoryStore } from "./memory/store.js";
import { agentExtension } from "./pi/extension.js";
import { agentInput, archiveAgentSession, discardAgentReplies, discardAgentSession, discardAgentTurn, openAgentStorage } from "./pi/storage.js";
import { COMPACT_CHECKPOINT_KEY, RESTORED_CONTEXT_KEY, captureCompactSession, currentCompactEntry, restoreCompactSession, restoredInputJobs, type CompactCheckpoint, type RestoredContext } from "./pi/checkpoint.js";
import { openRouterModels, type AgentModels } from "./pi/models.js";
import { TelegramBot, TelegramError, splitTelegramText, telegramImage, telegramVideo, type TelegramImage, type TelegramVideo } from "./telegram.js";
import { VideoStore } from "./video/store.js";
import { ImageStore } from "./image/store.js";
import { TelegramOutput, replyParts, type TextDelivery } from "./telegram-output.js";
import { WebAccess } from "./web/access.js";
import { webExtension } from "./web/extension.js";
import { SpeechDelivery, type SpeechReceipt } from "./speech/delivery.js";
import { speechExtension } from "./speech/extension.js";
import { installSpeechSkill } from "./speech/skill.js";

const JOB_TIMEOUT_MS = 6 * 60 * 60_000;
const CONTEXT = BACKGROUND_CONTEXT;
const MEDIA_BATCH_QUIET_MS = 1200;
const ABORT_FENCE_KEY = "control:abort-through";

class ReplyAborted extends Error {
  constructor() { super("Reply aborted by user"); this.name = "ReplyAborted"; }
}

const isControl = (job: Job) => job.kind === "last" || job.kind === "abort";
interface AbortFence { sequence: number; id: string; }

export interface Job extends TextDelivery {
  id: string;
  requestId: string;
  kind: "user" | "compact" | "new" | "retry" | "pop" | "start" | "last" | "abort";
  input: string;
  image?: TelegramImage;
  video?: TelegramVideo;
  mediaGroupId?: string;
  // Retain this persisted key for existing jobs; members may include videos.
  imageBatch?: string[];
  batchId?: string;
  chatId?: number;
  replyTo?: number;
  sequence: number;
  createdAt: number;
  submissionId?: number;
  compactionTaskId?: TaskId<CompactionResult>;
  compactCheckpoint?: string;
  archivePath?: string;
  outputAfter?: EntryId | null;
  retry?: { entry?: EntryId; input?: string; image?: TelegramImage; video?: TelegramVideo; imageBatch?: string[]; replyTo: number };
  pop?: { entry?: EntryId; replyTo?: number };
  start?: { checkpoint?: string };
  last?: { replyTo?: number };
  abortStopped?: boolean;
  discarded?: boolean;
}

async function jobId(requestId: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requestId));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class AgentBackend extends AgentFiles {
  declare protected env: Env;
  private draining?: Promise<void>;
  private execution?: { job: Job; controller: AbortController; done: Promise<void> };
  private readonly controls = new Map<string, Promise<void>>();
  private aborting?: Promise<void>;
  private active?: { root: Conversation; registry: Registry; jobId: string; signal: AbortSignal; steers: Map<string, Promise<{ job: Job; submission: Submission } | undefined>> };
  private readonly memory: MemoryStore;
  private readonly videos: VideoStore;
  protected readonly images: ImageStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const base = env.MEMORY_PREFIX ?? "hermes/";
    this.memory = new MemoryStore(ctx.storage, `${base.replace(/\/$/, "")}/${ownerId(env)}/`, this);
    this.videos = new VideoStore(ctx.storage);
    this.images = new ImageStore(ctx.storage);
  }

  protected modelRuntime(): AgentModels { return openRouterModels(this.env, this.videos, this.images); }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/enqueue" && request.method === "POST") {
        const body = await jsonBody(request);
        const requestId = textField(body.requestId, "requestId", 200);
        const image = telegramImage(body.image);
        const video = telegramVideo(body.video);
        const input = image || video
          ? typeof body.input === "string" && body.input.length <= 8_000 ? body.input : textField(body.input, "input", 8_000)
          : textField(body.input, "input", 8_000);
        const mediaGroupId = body.mediaGroupId === undefined ? undefined : textField(body.mediaGroupId, "mediaGroupId", 256);
        if (image && video) throw new HttpError(400, "Only one Telegram attachment is allowed");
        if (body.kind !== undefined) throw new HttpError(400, "Invalid job kind");
        const chatId = body.chatId === undefined ? undefined : Number(body.chatId);
        if (chatId !== undefined && chatId !== Number(ownerId(this.env))) throw new HttpError(403, "Invalid chat");
        const replyTo = body.replyTo === undefined ? undefined : Number(body.replyTo);
        if (replyTo !== undefined && (!Number.isSafeInteger(replyTo) || replyTo < 1)) throw new HttpError(400, "Invalid reply message");
        const command = input.trim();
        const kind = image || video ? "user" : command === "/compact" ? "compact" : command === "/new" ? "new" : command === "/retry" ? "retry" : command === "/pop" ? "pop" : command === "/start" ? "start" : command === "/last" ? "last" : command === "/abort" ? "abort" : "user";
        const job = await this.enqueue({ requestId, input, image, video, mediaGroupId, kind, chatId, replyTo });
        this.ctx.waitUntil(isControl(job) ? this.control(job) : this.drain());
        return Response.json({ id: job.id, status: job.status }, { status: 202 });
      }
      throw new HttpError(404, "Not found");
    } catch (error) { return errorResponse(error); }
  }

  private pendingKey(sequence: number): string { return `pending:${String(sequence).padStart(16, "0")}`; }

  private async enqueue(input: Pick<Job, "requestId" | "kind" | "input" | "image" | "video" | "mediaGroupId" | "chatId" | "replyTo">): Promise<Job> {
    const id = await jobId(input.requestId);
    return this.ctx.storage.transaction((storage) => this.admit(storage, input, id));
  }

  private async admit(storage: DurableObjectTransaction, input: Pick<Job, "requestId" | "kind" | "input" | "image" | "video" | "mediaGroupId" | "chatId" | "replyTo">, id: string): Promise<Job> {
      const existing = await storage.get<Job>(`job:${id}`);
      if (existing) {
        if (existing.input !== input.input || existing.image?.fileId !== input.image?.fileId || existing.image?.fileSize !== input.image?.fileSize || existing.video?.fileId !== input.video?.fileId || existing.video?.fileSize !== input.video?.fileSize || existing.mediaGroupId !== input.mediaGroupId || existing.chatId !== input.chatId || existing.replyTo !== input.replyTo || existing.kind !== input.kind) throw new HttpError(409, "requestId already has different input");
        return existing;
      }
      const pending = await storage.list({ prefix: "pending:", limit: 65 });
      if (pending.size >= 64 && input.kind !== "last" && input.kind !== "abort") throw new HttpError(429, "Agent queue is full");
      const sequence = ((await storage.get<number>("sequence")) ?? 0) + 1;
      const job: Job = { ...input, id, sequence, createdAt: Date.now(), status: "pending", nextPart: 0, deliveryAttempts: 0 };
      await storage.put({ [`job:${id}`]: job, [this.pendingKey(sequence)]: id, sequence });
      if (job.kind === "abort") await storage.put(ABORT_FENCE_KEY, { sequence, id } satisfies AbortFence);
      await storage.setAlarm(Date.now());
      return job;
  }

  private control(job: Job): Promise<void> {
    const existing = this.controls.get(job.id);
    if (existing) return existing;
    const running = (async () => {
      try {
        if (job.status === "complete" || job.status === "failed") { await this.finish(job); return; }
        if (job.kind === "last" && !job.parts) {
          const source = await this.latestInputJob(job);
          const text = source ? `上一次用户输入：\n${await this.displayInput(source)}` : "当前没有可展示的用户输入。";
          job.last = { replyTo: source?.retry?.replyTo ?? source?.replyTo };
          job.parts = splitTelegramText(text);
          job.status = "ready";
          await this.ctx.storage.put(`job:${job.id}`, job);
        }
        if (job.kind === "abort" && !job.abortStopped) {
          const previous = this.aborting;
          const stopped = (previous ?? Promise.resolve()).catch(() => {}).then(() => this.stopReply(job));
          this.aborting = stopped;
          try { await stopped; }
          finally { if (this.aborting === stopped) this.aborting = undefined; }
        }
        const output = new TelegramOutput(this.ctx.storage, this.env.TELEGRAM_BOT_TOKEN, { ...job, replyTo: job.last?.replyTo ?? job.replyTo });
        if (job.chatId !== undefined) await output.deliver(`job:${job.id}`, job);
        else job.status = job.error ? "failed" : "complete";
        if (job.status === "complete" || job.status === "failed") await this.finish(job);
      } catch {
        job.error = job.kind === "abort" ? "abort_failed" : "last_failed";
        await this.ready(job, job.kind === "abort" ? "终止回复失败，请重新发送 /abort。" : "读取上一次输入失败，请稍后重试 /last。");
        const output = new TelegramOutput(this.ctx.storage, this.env.TELEGRAM_BOT_TOKEN, job);
        if (job.chatId !== undefined) await output.deliver(`job:${job.id}`, job);
        else job.status = "failed";
        if (job.status === "complete" || job.status === "failed") await this.finish(job);
      } finally { await this.schedule(); }
    })();
    this.controls.set(job.id, running);
    void running.finally(() => { if (this.controls.get(job.id) === running) this.controls.delete(job.id); }).catch(() => {});
    return running;
  }

  private async displayInput(source: Job): Promise<string> {
    const input = agentInput(this.ctx.storage.sql, source.requestId, source.retry?.entry);
    if (input) {
      const row = this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM entries WHERE id = ?", input.entry).toArray()[0];
      const content = row ? JSON.parse(row.record).model?.[0]?.content : undefined;
      if (typeof content === "string") return content.replace(/^\[\d{2}:\d{2}:\d{2}\]\r?\n/, "");
      if (Array.isArray(content)) return content.flatMap((block: Record<string, unknown>, index: number) => {
        if (block.type === "text") return index === 0 && /^\[\d{2}:\d{2}:\d{2}\]\r?\n$/.test(String(block.text)) ? [] : [String(block.text)];
        return [block.type === "video" ? "[视频]" : block.type === "image" || block.type === "image_ref" ? "[图片]" : "[附件]"];
      }).join("\n");
    }
    const batch = source.retry?.imageBatch ?? source.imageBatch;
    let members = batch ? await Promise.all(batch.map(id => this.ctx.storage.get<Job>(`job:${id}`))) : [source];
    if (!batch && source.kind === "user" && (source.image || (source.video && source.mediaGroupId))) {
      let pending: Job[] = [];
      for (const id of (await this.ctx.storage.list<string>({ prefix: "pending:", limit: 100 })).values()) {
        const candidate = (await this.ctx.storage.get<Job>(`job:${id}`))!;
        if (candidate.sequence > source.sequence) break;
        if (candidate.kind === "last") continue;
        if (candidate.kind !== "user" || candidate.batchId || !(candidate.image || (candidate.video && source.mediaGroupId))
          || candidate.mediaGroupId !== source.mediaGroupId || candidate.chatId !== source.chatId) pending = [];
        else {
          if (pending.length && candidate.createdAt - pending.at(-1)!.createdAt > MEDIA_BATCH_QUIET_MS) pending = [];
          pending.push(candidate);
        }
        if (candidate.id === source.id) { if (pending.length) members = pending; break; }
      }
    }
    return members.filter((member): member is Job => !!member).flatMap(member => {
      const text = member.retry?.input ?? member.input;
      return [...(text ? [text] : []), ...(member.image || member.retry?.image ? ["[图片]"] : []), ...(member.video || member.retry?.video ? ["[视频]"] : [])];
    }).join("\n");
  }

  private async stopReply(command: Job): Promise<void> {
    const execution = this.execution;
    if (execution && execution.job.sequence < command.sequence) {
      // Seal received album members before cancellation removes the leader from
      // the pending queue, so retry still sees the complete logical input.
      await this.collectMedia(execution.job, undefined, true);
      execution.controller.abort(new ReplyAborted());
      await execution.done;
    }
    // Also cancel durable work when /abort is received after an eviction. This
    // uses no model credentials and never submits the command as model input.
    const harness = await Harness.open(await openAgentStorage(this.ctx.storage), { models: createModels(), registry: createRegistry() }, CONTEXT);
    try { await this.abortConversation(await harness.root(CONTEXT)); }
    finally { await harness.close(CONTEXT); }
    for (const id of (await this.ctx.storage.list<string>({ prefix: "pending:", limit: 100 })).values()) {
      const candidate = await this.ctx.storage.get<Job>(`job:${id}`);
      if (!candidate || candidate.sequence >= command.sequence || isControl(candidate)) continue;
      await this.collectMedia(candidate, undefined, true);
      if (candidate.batchId) continue;
      candidate.status = "failed";
      candidate.error = "user_aborted";
      delete candidate.parts;
      await this.finish(candidate);
    }
    command.abortStopped = true;
    await this.ready(command, "已终止当前回复，用户输入已保留。");
  }

  private async abortConversation(root: Conversation): Promise<void> {
    try {
      // Pi normally withdraws queued steering inputs on abort. Place them as
      // unanswered user entries first: /abort + /retry must retain the same
      // user history as a completed run followed by /retry.
      await root.commit(async tx => {
        const inbox = await tx.doc(InboxDoc, root.id);
        for (const item of inbox.items) {
          if (item.mode === "write") continue;
          const entry = await tx.appendEntry(root.id, {
            ...(item.entry ?? { kind: UserEntry.kind }),
            model: [{ role: "user", content: item.content as UserMessage["content"], timestamp: Date.now() }],
          });
          tx.placeSubmission(item.id, entry.id);
          tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
        }
        inbox.items = inbox.items.filter(item => item.mode === "write");
      }, CONTEXT);
    } finally { await root.abort(CONTEXT, { background: true }); }
  }

  private registry(store: MemoryStore, job: Job) {
    const registry = createRegistry();
    const web = new WebAccess(this.env);
    registry.install(agentExtension(store));
    registry.install(bashExtension(this, `/${store.prefix.slice(0, -1)}`, web));
    registry.install(webExtension(web));
    this.installSpeech(registry, job);
    return registry;
  }

  private installSpeech(registry: Registry, job: Job) {
    if (job.kind !== "user" && job.kind !== "retry") return;
    installSpeechSkill(this.ctx.storage, this, this.memory.prefix);
    const key = `speech:${job.id}`;
    registry.install(speechExtension(new SpeechDelivery(this.env, {
      claim: (candidate) => this.ctx.storage.transaction(async storage => {
        const existing = await storage.get<SpeechReceipt>(key);
        if (!existing) await storage.put(key, candidate);
        return existing;
      }),
      save: (receipt) => this.ctx.storage.put(key, receipt),
    }), job.retry?.replyTo ?? job.replyTo));
  }

  private async steerPending() {
    const active = this.active;
    if (!active) return;
    const needsBoundary = (candidate: Job) => !!(candidate.image || candidate.video) && (candidate.imageBatch?.length ?? 0) < 2;
    for (const id of (await this.ctx.storage.list<string>({ prefix: "pending:", limit: 65 })).values()) {
      const job = await this.ctx.storage.get<Job>(`job:${id}`);
      if (this.active !== active) return;
      if (job?.id !== active.jobId && (job?.kind === "new" || job?.kind === "retry" || job?.kind === "pop" || job?.kind === "start" || job?.kind === "abort")) break;
      if (!job || job.id === active.jobId || job.kind !== "user" || job.status !== "pending" || job.batchId || active.steers.has(id)) continue;
      try { await this.collectMedia(job, active.signal); }
      catch (error) { if (active.signal.aborted) return; throw error; }
      if (this.active !== active) return;
      if (job.batchId || active.steers.has(id)) continue;
      // Pi keeps queued inputs in one SQLite document. Albums use small
      // references; single attachments retain the existing boundary behavior.
      for (const forwarded of active.steers.values()) {
        const placed = await forwarded;
        if (placed && (needsBoundary(job) || needsBoundary(placed.job)) && (await placed.submission.status(CONTEXT)).status === "queued") return;
      }
      if (this.active !== active) return;
      if (active.steers.has(id)) continue;
      const forwarded = (async () => {
        this.installSpeech(active.registry, job);
        let submission: Submission;
        try { submission = await this.submitInput(active.root, job, active.signal, "steer"); }
        catch (error) {
          if (!(job.image || job.video) || !(error instanceof HttpError) || active.signal.aborted) throw error;
          // A bad attachment must not abort the conversation it was steering.
          job.error = "agent_generation_failed";
          await this.ready(job, error.message);
          return;
        }
        job.submissionId = submission.id;
        await this.ctx.storage.put(`job:${id}`, job);
        return { job, submission };
      })();
      active.steers.set(id, forwarded);
      try { await forwarded; }
      catch (error) { if (active.signal.aborted) return; throw error; }
    }
  }

  private async collectMedia(job: Job, signal?: AbortSignal, force = false): Promise<void> {
    if (!(job.image || (job.video && job.mediaGroupId)) || job.kind !== "user" || job.imageBatch || job.batchId) return;
    while (true) {
      signal?.throwIfAborted();
      const delay = await this.ctx.storage.transaction(async storage => {
        const current = (await storage.get<Job>(`job:${job.id}`))!;
        if (current.imageBatch || current.batchId) { Object.assign(job, current); return 0; }
        const members: Job[] = [];
        for (const id of (await storage.list<string>({ prefix: "pending:", limit: 65 })).values()) {
          const candidate = (await storage.get<Job>(`job:${id}`))!;
          if (!members.length && id !== job.id) continue;
          if (candidate.kind === "last") continue;
          const previous = members.at(-1);
          const supported = candidate.image || (candidate.video && job.mediaGroupId);
          if (candidate.kind !== "user" || candidate.status !== "pending" || !supported || candidate.batchId
            || candidate.chatId !== job.chatId || candidate.mediaGroupId !== job.mediaGroupId
            || (previous && candidate.createdAt - previous.createdAt > MEDIA_BATCH_QUIET_MS)) break;
          members.push(candidate);
          if (members.length === 10) break;
        }
        if (!members.length) return 0;
        const remaining = members.at(-1)!.createdAt + MEDIA_BATCH_QUIET_MS - Date.now();
        if (remaining > 0 && !force) return remaining;
        // Freeze membership before downloading. Replays and restarts must reuse
        // the same logical input rather than absorb a later, unrelated photo.
        current.imageBatch = members.sort((a, b) => (a.replyTo ?? a.sequence) - (b.replyTo ?? b.sequence)).map(member => member.id);
        await storage.put(`job:${current.id}`, current);
        for (const member of members) if (member.id !== current.id) {
          await storage.put(`job:${member.id}`, { ...member, batchId: current.id });
          await storage.delete(this.pendingKey(member.sequence));
        }
        Object.assign(job, current);
        return 0;
      });
      if (!delay) return;
      await scheduler.wait(delay, { signal });
    }
  }

  private async submitInput(root: Conversation, job: Job, signal: AbortSignal, whenBusy?: "steer"): Promise<Submission> {
    let content: UserMessage["content"] = job.retry?.input ?? job.input;
    const image = job.retry?.image ?? job.image;
    const video = job.retry?.video ?? job.video;
    // A recovered submission already owns its image bytes in Pi storage. Do not
    // depend on Telegram file availability again when resuming the same input.
    if ((image || video) && !await root.commit(tx => tx.submissionByRequest(root.id, job.requestId), CONTEXT)) {
      const bot = new TelegramBot(this.env.TELEGRAM_BOT_TOKEN);
      const batch = job.retry?.imageBatch ?? job.imageBatch;
      if (batch && batch.length > 1) {
        const blocks: unknown[] = [];
        for (const id of batch) {
          const member = await this.ctx.storage.get<Job>(`job:${id}`);
          if (!member?.image && !member?.video) throw new HttpError(500, "相册批次不完整，请重发。");
          if (member.input.trim()) blocks.push({ type: "text", text: member.input });
          blocks.push(await this.loadAttachment(member, bot, signal, true));
        }
        content = blocks as UserMessage["content"];
      } else {
        const attachment = await this.loadAttachment({ image, video }, bot, signal);
        // The video extension is JSON-persisted by Pi; the provider adapter handles its wire format.
        content = [...(content.trim() ? [{ type: "text", text: content }] : []), attachment] as UserMessage["content"];
      }
    }
    signal.throwIfAborted();
    return root.submit({ type: "input", content, requestId: job.requestId, whenBusy }, CONTEXT);
  }

  private async loadAttachment(input: Pick<Job, "image" | "video">, bot: TelegramBot, signal: AbortSignal, storeImage = false) {
    if (input.image) {
      const image = await bot.downloadImage(input.image, signal);
      return storeImage ? this.images.save(input.image.fileId, image) : image;
    }
    if (!input.video) throw new HttpError(400, "Missing Telegram attachment");
    const existing = this.videos.find(input.video.fileId);
    if (existing) return existing;
    const downloaded = await bot.downloadVideo(input.video, signal);
    return this.videos.save(input.video.fileId, downloaded.bytes, downloaded.mimeType, signal);
  }

  private async ready(job: Job, reply: string) {
    job.parts = replyParts(reply);
    job.status = "ready";
    await this.ctx.storage.put(`job:${job.id}`, job);
  }

  private async latestInputJob(job: Job): Promise<Job | undefined> {
    const restored = await this.ctx.storage.get<RestoredContext>(RESTORED_CONTEXT_KEY);
    const restoredJobs = restored ? restoredInputJobs(this.ctx.storage.sql) : undefined;
    let source: Job | undefined;
    let reset = 0;
    let startAfter: string | undefined;
    while (true) {
      const page = await this.ctx.storage.list<Job>({ prefix: "job:", startAfter, limit: 100 });
      if (!page.size) break;
      for (const [key, candidate] of page) {
        startAfter = key;
        if (candidate.sequence >= job.sequence || candidate.discarded || candidate.batchId) continue;
        if (restored && candidate.sequence < restored.sequence && !restoredJobs!.has(candidate.id)) continue;
        if (candidate.kind === "new" && candidate.error !== "session_reset_failed" && candidate.error !== "user_aborted") reset = Math.max(reset, candidate.sequence);
        if ((candidate.kind === "user" || (candidate.kind === "retry" && candidate.retry)) && candidate.chatId === job.chatId && candidate.sequence > (source?.sequence ?? 0)) source = candidate;
      }
    }
    return source && source.sequence > reset ? source : undefined;
  }

  private async checkpointInputJobs(): Promise<string[]> {
    const placements = this.ctx.storage.sql.exec<{ request_id: string; entry: EntryId }>(`SELECT json_extract(s.record, '$.requestId') AS request_id, e.id AS entry
      FROM submissions s JOIN entries e ON e.id = json_extract(s.record, '$.entry')
      WHERE e.conversation_id = ? AND json_extract(s.record, '$.type') = 'input'
        AND json_extract(e.record, '$.kind') = 'pi.user' AND json_extract(e.record, '$.model[0].role') = 'user'`, ROOT_CONVERSATION_ID).toArray();
    const byRequest = new Map(placements.map(row => [row.request_id, row.entry]));
    const entries = new Set(placements.map(row => row.entry));
    const restored = await this.ctx.storage.get<RestoredContext>(RESTORED_CONTEXT_KEY);
    const restoredJobs = restored ? restoredInputJobs(this.ctx.storage.sql) : undefined;
    const inputs: string[] = [];
    let startAfter: string | undefined;
    while (true) {
      const page = await this.ctx.storage.list<Job>({ prefix: "job:", startAfter, limit: 100 });
      if (!page.size) break;
      for (const [key, candidate] of page) {
        startAfter = key;
        if (candidate.discarded || (restored && candidate.sequence < restored.sequence && !restoredJobs!.has(candidate.id))) continue;
        if ((candidate.kind === "user" || (candidate.kind === "retry" && candidate.retry))
          && entries.has(candidate.retry?.entry ?? byRequest.get(candidate.requestId)!)) inputs.push(candidate.id);
      }
    }
    return inputs;
  }

  private async adoptCompactCheckpoint(): Promise<CompactCheckpoint | undefined> {
    const existing = await this.ctx.storage.get<CompactCheckpoint>(COMPACT_CHECKPOINT_KEY);
    if (existing) return existing;
    const entry = currentCompactEntry(this.ctx.storage.sql);
    if (entry === undefined) return;
    const checkpoint: CompactCheckpoint = { id: `existing:${entry}`, createdAt: Date.now() };
    const inputs = await this.checkpointInputJobs();
    await this.ctx.storage.transaction(async storage => {
      captureCompactSession(this.ctx.storage.sql, inputs);
      await storage.put(COMPACT_CHECKPOINT_KEY, checkpoint);
    });
    return checkpoint;
  }

  private async saveCompactCheckpoint(job: Job, reply: string): Promise<void> {
    if (job.compactCheckpoint) { await this.ready(job, reply); return; }
    const inputs = await this.checkpointInputJobs();
    const updated: Job = { ...job, compactCheckpoint: job.id, parts: replyParts(reply), status: "ready" };
    try {
      await this.ctx.storage.transaction(async storage => {
        captureCompactSession(this.ctx.storage.sql, inputs);
        await storage.put(COMPACT_CHECKPOINT_KEY, { id: job.id, createdAt: Date.now() } satisfies CompactCheckpoint);
        await storage.put(`job:${job.id}`, updated);
      });
    } catch { throw new HttpError(500, "上下文已压缩，但保存 /start 恢复点失败；原有恢复点已保留。"); }
    Object.assign(job, updated);
  }

  private async startSession(job: Job): Promise<void> {
    const success = "已恢复到最近一次 /compact 后的上下文，记忆和 Skill 文件已保留。";
    const empty = "尚无可恢复的压缩记录，请先执行 /compact 建立恢复点。";
    if (job.start) { await this.ready(job, job.start.checkpoint ? success : empty); return; }
    if (job.createdAt + JOB_TIMEOUT_MS <= Date.now()) throw new HttpError(408, "恢复请求已过期，未修改当前上下文。");
    const checkpoint = await this.adoptCompactCheckpoint();
    if (checkpoint) {
      // Closing an empty-model Harness only stops pending internal work; it never
      // needs model credentials or replays tools while swapping the session tables.
      const harness = await Harness.open(await openAgentStorage(this.ctx.storage), { models: createModels(), registry: createRegistry() }, CONTEXT);
      try { await (await harness.root(CONTEXT)).abort(CONTEXT, { background: true }); }
      finally { await harness.close(CONTEXT); }
    }
    const updated: Job = { ...job, start: checkpoint ? { checkpoint: checkpoint.id } : {}, parts: [checkpoint ? success : empty], status: "ready" };
    await this.ctx.storage.transaction(async storage => {
      if (checkpoint) {
        const inputs = restoreCompactSession(this.ctx.storage.sql);
        for (const id of inputs) {
          const source = await storage.get<Job>(`job:${id}`);
          if (source?.discarded) await storage.put(`job:${id}`, { ...source, discarded: false });
        }
        await storage.put(RESTORED_CONTEXT_KEY, { sequence: job.sequence } satisfies RestoredContext);
      }
      await storage.put(`job:${job.id}`, updated);
    });
    Object.assign(job, updated);
  }

  private async prepareRetry(job: Job, output: TelegramOutput): Promise<boolean> {
    if (job.createdAt + JOB_TIMEOUT_MS <= Date.now()) throw new HttpError(408, "重试请求已过期，未清理上次回复。");
    const source = await this.latestInputJob(job);
    const replyTo = source?.retry?.replyTo ?? source?.replyTo;
    if (!source || replyTo === undefined) {
      await this.ready(job, "当前没有可重试的用户消息。");
      return false;
    }
    const input = agentInput(this.ctx.storage.sql, source.requestId, source.retry?.entry);
    const { models } = this.modelRuntime();
    const harness = await Harness.open(await openAgentStorage(this.ctx.storage), { models, registry: this.registry(this.memory, job), onReport: () => console.error("Pi Durable reported an internal task error") }, CONTEXT);
    try { await (await harness.root(CONTEXT)).abort(CONTEXT, { background: true }); }
    finally { await harness.close(CONTEXT); }
    await output.removeReplies({ entry: input?.entry ?? Number.MAX_SAFE_INTEGER, after: input ? input.after ?? 0 : Number.MAX_SAFE_INTEGER, replyTo, sequence: source.sequence });
    const imageBatch = source.retry?.imageBatch ?? source.imageBatch;
    const retry = input ? { entry: input.entry, imageBatch, replyTo } : { input: source.retry?.input ?? source.input, image: source.retry?.image ?? source.image, video: source.retry?.video ?? source.video, imageBatch, replyTo };
    // No Harness may retain a context cache while the old response payloads are removed.
    await this.ctx.storage.transaction(async storage => {
      if (input) discardAgentReplies(this.ctx.storage.sql, input.entry);
      await storage.put(`job:${job.id}`, { ...job, retry });
    });
    job.retry = retry;
    return true;
  }

  private async popTurn(job: Job, output: TelegramOutput): Promise<void> {
    const success = "已弹出上一轮对话，用户消息及其后的回复已移除；记忆和 Skill 文件已保留。";
    const empty = "当前没有可弹出的用户消息。";
    if (job.pop) { await this.ready(job, job.pop.replyTo === undefined ? empty : success); return; }
    if (job.createdAt + JOB_TIMEOUT_MS <= Date.now()) throw new HttpError(408, "弹出请求已过期，未清理上一轮对话。");
    const source = await this.latestInputJob(job);
    const replyTo = source?.retry?.replyTo ?? source?.replyTo;
    const input = source && replyTo !== undefined ? agentInput(this.ctx.storage.sql, source.requestId, source.retry?.entry) : undefined;
    const imageBatch = source?.retry?.imageBatch ?? source?.imageBatch;
    const inputIds: number[] = [];
    for (const id of imageBatch ?? []) {
      const member = await this.ctx.storage.get<Job>(`job:${id}`);
      if (member?.replyTo !== undefined) inputIds.push(member.replyTo);
    }
    if (source && replyTo !== undefined) {
      // Cleanup must work even when the configured model or its credentials are unavailable.
      const harness = await Harness.open(await openAgentStorage(this.ctx.storage), { models: createModels(), registry: createRegistry() }, CONTEXT);
      try { await (await harness.root(CONTEXT)).abort(CONTEXT, { background: true }); }
      finally { await harness.close(CONTEXT); }
      await output.removeReplies({ entry: input?.entry ?? Number.MAX_SAFE_INTEGER, after: input ? input.after ?? 0 : Number.MAX_SAFE_INTEGER, replyTo, sequence: source.sequence, inputIds }, true);
    }
    const checkpoint: Job = { ...job, pop: replyTo === undefined ? {} : { entry: input?.entry, replyTo }, parts: [replyTo === undefined ? empty : success], status: "ready" };
    // The removed input, its retries and the completion checkpoint share one transaction.
    // Retain job records for Telegram update deduplication, but never select them again.
    await this.ctx.storage.transaction(async storage => {
      if (input) discardAgentTurn(this.ctx.storage.sql, input.entry);
      if (replyTo !== undefined) {
        let startAfter: string | undefined;
        while (true) {
          const page = await storage.list<Job>({ prefix: "job:", startAfter, limit: 100 });
          if (!page.size) break;
          for (const [key, candidate] of page) {
            startAfter = key;
            if (candidate.sequence < job.sequence && candidate.chatId === job.chatId
              && (candidate.kind === "user" || (candidate.kind === "retry" && candidate.retry))
              && ((candidate.retry?.replyTo ?? candidate.replyTo) === replyTo || imageBatch?.includes(candidate.id))) await storage.put(key, { ...candidate, discarded: true });
          }
        }
      }
      await storage.put(`job:${job.id}`, checkpoint);
    });
    Object.assign(job, checkpoint);
  }

  private async retrySubmission(root: Conversation, harness: Harness, job: Job): Promise<Submission> {
    const id = await root.commit(async tx => {
      const existing = await tx.submissionByRequest(root.id, job.requestId);
      if (existing) return existing.id;
      const live = await tx.doc(LiveDoc, root.id);
      if (live.run) throw new Error("Retry conversation is busy");
      const submission = await tx.createSubmission({ type: "input", conversationId: root.id, requestId: job.requestId, status: "placed", entry: job.retry!.entry! });
      live.run = { taskId: await tx.createTask(GenerationTask, {}, { conversationId: root.id, ownership: { kind: "conversation" } }), inputs: [submission.id] };
      return submission.id;
    }, CONTEXT);
    const submission = await harness.submission(id, CONTEXT);
    if (!submission) throw new Error("Retry submission is missing");
    return submission;
  }

  private async answer(job: Job, output: TelegramOutput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (job.createdAt + JOB_TIMEOUT_MS <= Date.now()) throw new Error("Agent job timed out");
    if (job.kind === "new") {
      await this.adoptCompactCheckpoint();
      await this.ctx.storage.transaction(async storage => {
        discardAgentSession(this.ctx.storage.sql);
        await storage.delete(RESTORED_CONTEXT_KEY);
        job.parts = ["已开始新会话，旧会话已归档；记忆和 Skill 文件已保留。"];
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
    let compacted = false;
    let root: Awaited<ReturnType<typeof harness.root>> | undefined;
    let unsubscribe: (() => void) | undefined;
    let forwarding = Promise.resolve();
    const steers: NonNullable<AgentBackend["active"]>["steers"] = new Map();
    const outputAbort = new AbortController();
    let abortRequest: Promise<void> | undefined;
    let rejectAbort!: (error: unknown) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
    void cancelled.catch(() => {});
    const onAbort = () => {
      this.active = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      output.stop();
      outputAbort.abort(signal.reason);
      if (root && !abortRequest) {
        abortRequest = this.abortConversation(root);
        void abortRequest.catch(() => {});
      }
      rejectAbort(signal.reason ?? new ReplyAborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
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
      signal.throwIfAborted();
      root = await harness.root(CONTEXT, { agent: { model } });
      signal.throwIfAborted();
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
            compacted = true;
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
          const submission = job.kind === "retry" && job.retry?.entry !== undefined ? await this.retrySubmission(root, harness, job) : await this.submitInput(root, job, outputAbort.signal);
          outputAbort.signal.throwIfAborted();
          job.submissionId = submission.id;
          await this.ctx.storage.put(`job:${job.id}`, job);
          outputAbort.signal.throwIfAborted();
          const active: NonNullable<AgentBackend["active"]> = { root, registry, jobId: job.id, signal: outputAbort.signal, steers };
          this.active = active;
          await this.steerPending();
          const settled = await submission.wait(CONTEXT);
          if (settled.status !== "done") throw new Error(String(settled.detail ?? settled.reason));
          if (settled.type !== "input") throw new Error(String(settled.detail ?? settled.type));
          const answers = new Set([settled.answer]);
          const steeredJobs: Job[] = [];
          for (const forwarded of active.steers.values()) {
            const placed = await forwarded;
            if (!placed) continue;
            const { job: steered, submission } = placed;
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
        cancelled,
      ]);
      signal.throwIfAborted();
      if (reply !== undefined) {
        if (compacted) { await harness.close(CONTEXT); await this.saveCompactCheckpoint(job, reply); }
        else await this.ready(job, reply);
      }
    } catch (error) {
      // A timed-out run must not resume later under a different user job.
      this.active = undefined;
      unsubscribe?.();
      if (error instanceof TelegramError) outputAbort.abort(error);
      if (signal.aborted) {
        output.stop();
        outputAbort.abort(signal.reason);
        await (abortRequest ?? (root && this.abortConversation(root)))?.catch(() => {});
        await Promise.allSettled(steers.values());
        await forwarding.catch(() => {});
      } else {
        await root?.abort(CONTEXT).catch(() => {});
        await forwarding;
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.active = undefined;
      unsubscribe?.();
      outputAbort.abort();
      if (timeout) clearTimeout(timeout);
      await harness.close(CONTEXT);
    }
  }

  private async finish(job: Job): Promise<void> {
    await this.ctx.storage.transaction(async storage => {
      await storage.put(`job:${job.id}`, job);
      await storage.delete(this.pendingKey(job.sequence));
      for (const id of job.imageBatch ?? []) if (id !== job.id) {
        const member = await storage.get<Job>(`job:${id}`);
        if (member) await storage.put(`job:${id}`, { ...member, status: job.status, error: job.error, submissionId: job.submissionId });
        if (member) await storage.delete(this.pendingKey(member.sequence));
      }
    });
  }

  private async process(job: Job): Promise<void> {
    if (isControl(job)) { await this.control(job); return; }
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const execution = { job, controller, done };
    this.execution = execution;
    try {
      // Register execution before the first await so a concurrent abort cannot
      // miss work that has read an older queue checkpoint but has not started.
      const fence = await this.ctx.storage.get<AbortFence>(ABORT_FENCE_KEY);
      controller.signal.throwIfAborted();
      if (fence && job.sequence > fence.sequence) {
        const command = await this.ctx.storage.get<Job>(`job:${fence.id}`);
        if (command && !command.abortStopped) await this.control(command);
        if (command && !(await this.ctx.storage.get<Job>(`job:${fence.id}`))?.abortStopped) throw new HttpError(409, "上一次终止尚未完成，请重新发送 /abort。");
      }
      if (fence && job.sequence < fence.sequence) {
        await this.collectMedia(job, undefined, true);
        throw new ReplyAborted();
      }
      await this.processJob(job, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof ReplyAborted)) throw error;
      job.status = "failed";
      job.error = "user_aborted";
      delete job.parts;
      await this.finish(job);
    } finally {
      if (this.execution === execution) this.execution = undefined;
      resolveDone();
    }
  }

  private async processJob(job: Job, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.collectMedia(job, signal);
    signal.throwIfAborted();
    if (job.batchId) return;
    if (job.status === "complete" || job.status === "failed") { await this.finish(job); return; }
    // Stop persisted jobs from removed features before they can resume a conversation.
    if (!["user", "compact", "new", "retry", "pop", "start"].includes(job.kind)) {
      if (agentInput(this.ctx.storage.sql, job.requestId)) {
        const { models } = this.modelRuntime();
        const harness = await Harness.open(await openAgentStorage(this.ctx.storage), { models, registry: createRegistry() }, CONTEXT);
        try { await (await harness.root(CONTEXT)).abort(CONTEXT, { background: true }); }
        finally { await harness.close(CONTEXT); }
      }
      job.status = "failed";
      job.error = "unsupported_job_kind";
      await this.finish(job);
      return;
    }
    if (job.retryAt && job.retryAt > Date.now()) return;
    const output = new TelegramOutput(this.ctx.storage, this.env.TELEGRAM_BOT_TOKEN, job);
    const onAbort = () => output.stop();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (job.status === "pending" || job.status === "running") {
        job.status = "running";
        await this.ctx.storage.put(`job:${job.id}`, job);
        try {
          if ((job.kind === "compact" || job.kind === "new" || job.kind === "retry" || job.kind === "pop" || job.kind === "start") && job.archivePath === undefined) {
            const archivePath = `/${this.memory.prefix}archives/${job.createdAt}-${job.kind}-${job.id}`;
            try {
              await this.ctx.storage.transaction(async storage => {
                archiveAgentSession(this.ctx.storage.sql, this, archivePath);
                await storage.put(`job:${job.id}`, { ...job, archivePath });
              });
            } catch (error) {
              throw new HttpError(500, `历史上下文归档失败，未执行 /${job.kind}：${error instanceof Error ? error.message : String(error)}`);
            }
            job.archivePath = archivePath;
          }
          if (job.kind === "start") await this.startSession(job);
          else if (job.kind === "pop") await this.popTurn(job, output);
          else if (job.kind !== "retry" || job.retry || await this.prepareRetry(job, output)) await this.answer(job, output, signal);
        }
        catch (error) {
          if (signal.aborted) throw signal.reason;
          const cleanupFailed = (job.kind === "retry" && !job.retry) || (job.kind === "pop" && !job.pop);
          if (error instanceof TelegramError && !cleanupFailed) {
            job.status = "failed";
            job.error = error.uncertain ? "telegram_delivery_uncertain" : "telegram_delivery_failed";
            await this.finish(job);
            return;
          }
          job.error = cleanupFailed ? `${job.kind}_cleanup_failed` : job.kind === "compact" ? "compaction_failed" : job.kind === "new" ? "session_reset_failed" : job.kind === "start" ? "session_restore_failed" : "agent_generation_failed";
          job.parts = [cleanupFailed && !(error instanceof HttpError)
            ? job.kind === "pop" ? "弹出上一轮对话失败，历史未移除；Telegram 消息可能已部分删除，请检查删除时限后再试。" : "清理上次回复失败，未重新生成；Telegram 回复可能已部分删除，请检查删除时限后再试。"
            : error instanceof Error ? error.message : String(error)];
          job.status = "ready";
          await this.ctx.storage.put(`job:${job.id}`, job);
        }
      }
      signal.throwIfAborted();
      if (job.chatId !== undefined) await output.deliver(`job:${job.id}`, job, signal);
      else job.status = job.error ? "failed" : "complete";
      if (job.status === "complete" || job.status === "failed") await this.finish(job);
    } finally { signal.removeEventListener("abort", onAbort); }
  }

  private async nextJob(): Promise<Job | undefined> {
    const pending = await this.ctx.storage.list<string>({ prefix: "pending:", limit: 100 });
    let first: Job | undefined;
    let delayed: Job | undefined;
    for (const id of pending.values()) {
      const job = await this.ctx.storage.get<Job>(`job:${id}`);
      if (!job) throw new Error("Queue references a missing job");
      if (isControl(job)) {
        if (!job.retryAt || job.retryAt <= Date.now()) return job;
        delayed ??= job;
      } else first ??= job;
    }
    return first ?? delayed;
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
