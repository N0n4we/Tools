import { type ConversationId, type ContextEdit, type EntryDraft, type EntryRecord, type StorageWrite } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import type { FsObject } from "@stablemodels/durable-bash/object";
import { isVideoContent, oldestVideosOverBudget, OMITTED_VIDEO, type VideoContent } from "./store.js";

const RETIRE_VIDEOS = "telegram.video-omitted";
const VIDEO_JSON = `instr(record, '"type":"video"') > 0`;
// The old attachment writer serialized these four keys in this order.
const LEGACY_VIDEO_JSON = /\{"type":"video","id":"[a-f0-9]{64}","mimeType":"video\/(?:mp4|webm|mpeg|mov)","size":[0-9]+\}/g;

function videosIn(messages?: readonly Message[]): VideoContent[] {
  return (messages ?? []).flatMap(message => message.role === "user" && Array.isArray(message.content) ? (message.content as unknown[]).filter(isVideoContent) : []);
}

type ReplaceVideo = (video: VideoContent) => VideoContent | typeof OMITTED_VIDEO;

function replaceVideos(messages: readonly Message[], replace: ReplaceVideo): Message[] {
  return messages.map(message => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    const content = (message.content as unknown[]).map(block => isVideoContent(block) ? replace(block) : block) as typeof message.content;
    return { ...message, content };
  });
}

function replaceEntryVideos(entry: EntryRecord, replace: ReplaceVideo): EntryRecord {
  return {
    ...entry,
    ...(entry.model && { model: replaceVideos(entry.model, replace) }),
    ...(entry.edits && { edits: entry.edits.map(edit => edit.action === "replace" ? { ...edit, messages: replaceVideos(edit.messages, replace) } : edit) }),
  };
}

export function archiveVideoPlaceholders(record: string): string {
  return record.includes('"type":"video"') ? JSON.stringify(replaceEntryVideos(JSON.parse(record) as EntryRecord, () => OMITTED_VIDEO)) : record;
}

// Apply the budget when Pi places a user entry. Context edits also update a
// generation task that already holds Pi's cached view of the earlier entries.
export function prepareVideoEntry(sql: SqlStorage, conversationId: ConversationId, value: EntryDraft, staged: readonly EntryRecord[]): EntryDraft[] {
  const incoming = videosIn(value.model);
  if (!incoming.length) return [value];
  const current = staged.filter(entry => entry.conversationId === conversationId);
  const stagedHead = current.filter(entry => entry.head !== undefined).at(-1)?.head;
  const head = stagedHead ?? sql.exec<{ head: number }>(
    "SELECT head FROM entries WHERE conversation_id = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1", conversationId,
  ).toArray()[0]?.head ?? 0;
  const persisted = sql.exec<{ record: string }>(
    `SELECT record FROM entries WHERE conversation_id = ? AND id >= ? AND ${VIDEO_JSON} ORDER BY id`, conversationId, head,
  ).toArray().map(row => JSON.parse(row.record) as EntryRecord);
  const earlier = [...persisted, ...current.filter(entry => entry.id >= head)];
  const alreadyRetired = new Set(current.filter(entry => entry.kind === RETIRE_VIDEOS).flatMap(entry => entry.data as string[]));
  const all = [...earlier.flatMap(entry => videosIn(entry.model)).filter(video => !alreadyRetired.has(video.id)), ...incoming];
  const retired = new Set(all.slice(0, oldestVideosOverBudget(all)).map(video => video.id));
  const replace: ReplaceVideo = video => retired.has(video.id) || alreadyRetired.has(video.id) ? OMITTED_VIDEO : video;
  if (!retired.size) return [value];
  const edits: ContextEdit[] = earlier.flatMap(entry => videosIn(entry.model).some(video => retired.has(video.id))
    ? [{ target: entry.id, action: "replace", messages: replaceVideos(entry.model!, replace) }] : []);
  const updated = { ...value, model: replaceVideos(value.model!, replace) };
  return edits.length ? [{ kind: RETIRE_VIDEOS, data: [...retired], edits }, updated] : [updated];
}

function rewriteEntries(sql: SqlStorage, table: "entries" | "compact_snapshot_entries", replace: (entry: EntryRecord) => EntryRecord, filter = "", ...params: SqlStorageValue[]): void {
  if (!sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length) return;
  let after = 0;
  for (;;) {
    const rows = sql.exec<{ id: number; record: string }>(
      `SELECT id, record FROM ${table} WHERE id > ? AND ${VIDEO_JSON} ${filter} ORDER BY id LIMIT 1`, after, ...params,
    ).toArray();
    const row = rows[0];
    if (!row) return;
    const updated = JSON.stringify(replace(JSON.parse(row.record) as EntryRecord));
    if (updated !== row.record) sql.exec(`UPDATE ${table} SET record = ? WHERE id = ?`, updated, row.id);
    after = row.id;
  }
}

export function commitVideoPlaceholders(sql: SqlStorage, writes: readonly StorageWrite[]): void {
  for (const write of writes) {
    if (write.type !== "entry") continue;
    const entry = write.value;
    if (entry.kind === RETIRE_VIDEOS) {
      const retired = new Set(entry.data as string[]);
      rewriteEntries(sql, "entries", record => replaceEntryVideos(record, video => retired.has(video.id) ? OMITTED_VIDEO : video), "AND conversation_id = ?", entry.conversationId);
    }
    if (entry.head !== undefined) {
      const head = entry.head;
      rewriteEntries(sql, "entries", record => {
        if (record.id < head) return replaceEntryVideos(record, () => OMITTED_VIDEO);
        if (!record.edits) return record;
        const edits = record.edits.map(edit => edit.action === "replace" && edit.target < head
          ? { ...edit, messages: replaceVideos(edit.messages, () => OMITTED_VIDEO) } : edit);
        return { ...record, edits };
      }, "AND conversation_id = ?", entry.conversationId);
    }
  }
}

export function retireCheckpointVideos(sql: SqlStorage): void {
  rewriteEntries(sql, "compact_snapshot_entries", record => replaceEntryVideos(record, () => OMITTED_VIDEO));
}

type ArchiveFiles = Pick<FsObject, "readFile" | "writeFile">;

export function videoStorageMigrated(sql: SqlStorage): boolean {
  return sql.exec("SELECT 1 FROM video_storage_migrations WHERE version = 1").toArray().length > 0;
}

export function migrateVideoStorage(storage: DurableObjectStorage, files: ArchiveFiles, archiveRoot: string): void {
  const { sql } = storage;
  sql.exec("CREATE TABLE IF NOT EXISTS video_storage_migrations (version INTEGER PRIMARY KEY)");
  if (videoStorageMigrated(sql)) return;
  storage.transactionSync(() => {
    rewriteEntries(sql, "entries", entry => replaceEntryVideos(entry, () => OMITTED_VIDEO));
    retireCheckpointVideos(sql);
    retireInboxVideos(sql);
    migrateVideoArchives(sql, files, archiveRoot);
    sql.exec("DROP TABLE IF EXISTS telegram_video_chunks");
    sql.exec("DROP TABLE IF EXISTS telegram_videos");
    sql.exec("INSERT INTO video_storage_migrations VALUES (1)");
  });
}

function retireInboxVideos(sql: SqlStorage): void {
  if (!sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'document_revisions' AND type = 'table'").toArray().length) return;
  // A persisted inbox may contain a queued video from the previous deployment.
  // Rewrite complete content blocks in both base documents and delta values.
  const placeholder = JSON.stringify(OMITTED_VIDEO);
  for (const table of ["document_revisions", "compact_snapshot_document_revisions"]) {
    const documents = table === "document_revisions" ? "documents" : "compact_snapshot_documents";
    if (!sql.exec("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'", table).toArray().length) continue;
    const blocks = sql.exec<{ document_id: number; seq: number; path: string }>(`SELECT revisions.document_id, revisions.seq, tree.fullkey AS path
      FROM ${table} AS revisions JOIN ${documents} AS docs ON docs.id = revisions.document_id
      JOIN json_tree(revisions.content) AS tree
      WHERE docs.kind = 'pi.inbox' AND tree.type = 'object'
        AND CASE WHEN tree.type = 'object' THEN tree.value ->> '$.type' END = 'video'`).toArray();
    for (const { document_id, seq, path } of blocks) {
      sql.exec(`UPDATE ${table} SET content = json_set(content, ?, json(?)) WHERE document_id = ? AND seq = ?`,
        path, placeholder, document_id, seq);
    }
  }
}

function migrateVideoArchives(sql: SqlStorage, files: ArchiveFiles, archiveRoot: string): void {
  const parts = sql.exec<{ path: string }>(`SELECT path FROM files WHERE is_dir = 0 AND symlink_target IS NULL AND substr(path, 1, ?) = ?
    AND path GLOB '*/context.json.part-*' ORDER BY path`, archiveRoot.length, archiveRoot).toArray();
  const placeholder = JSON.stringify(OMITTED_VIDEO);
  let previousPath: string | undefined;
  let previous = "";
  let original = "";
  const write = (path: string, content: string) => { if (content !== original) files.writeFile(path, content); };
  for (const { path } of parts) {
    const current = files.readFile(path).content;
    if (previousPath && previousPath.slice(0, -6) === path.slice(0, -6)) {
      // A video reference can straddle two file parts. Keep each replacement
      // within the original byte bounds of both parts.
      const boundary = previous.length;
      let split = boundary;
      const combined = (previous + current).replace(LEGACY_VIDEO_JSON, (match, offset: number) => {
        const left = Math.min(match.length, Math.max(0, boundary - offset));
        split += Math.min(placeholder.length, left) - left;
        return placeholder;
      });
      write(previousPath, combined.slice(0, split));
      previous = combined.slice(split);
    } else {
      if (previousPath) write(previousPath, previous.replace(LEGACY_VIDEO_JSON, placeholder));
      previous = current;
    }
    previousPath = path;
    original = current;
  }
  if (previousPath) write(previousPath, previous.replace(LEGACY_VIDEO_JSON, placeholder));
}
