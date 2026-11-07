import { ROOT_CONVERSATION_ID, type EntryId } from "@earendil-works/pi-durable";
import { HttpError } from "../http.js";

export const COMPACT_CHECKPOINT_KEY = "pi:compact-checkpoint";
export const RESTORED_CONTEXT_KEY = "pi:restored-context";
export interface CompactCheckpoint { id: string; createdAt: number; }
export interface RestoredContext { sequence: number; }

// Pi Durable 1.4.0 session tables. Keep durable_metadata's increasing IDs/commit
// sequences live, so restoring an old snapshot never reuses output receipt IDs.
const TABLES = ["record_ids", "conversations", "entries", "tasks", "submissions", "documents", "document_revisions"] as const;
const saved = (table: string) => `compact_snapshot_${table}`;
const exists = (sql: SqlStorage, table: string) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length > 0;

export function idleSession(sql: SqlStorage): boolean {
  return (!exists(sql, "tasks") || !sql.exec("SELECT 1 FROM tasks WHERE status != 'terminal' LIMIT 1").toArray().length)
    && (!exists(sql, "submissions") || !sql.exec("SELECT 1 FROM submissions WHERE status IN ('queued', 'placed') LIMIT 1").toArray().length);
}

// SQL copies preserve all row sizes and avoid assembling a potentially large
// session (including inline images) into one JSON value. The caller owns a transaction.
export function captureCompactSession(sql: SqlStorage, inputJobs: string[]): void {
  if (!idleSession(sql)) throw new HttpError(409, "上下文仍有未完成的任务，暂不能保存压缩恢复点。");
  for (const table of TABLES) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${saved(table)} AS SELECT * FROM ${table} WHERE 0`);
    sql.exec(`DELETE FROM ${saved(table)}`);
    sql.exec(`INSERT INTO ${saved(table)} SELECT * FROM ${table}`);
  }
  sql.exec("CREATE TABLE IF NOT EXISTS compact_snapshot_inputs (job_id TEXT PRIMARY KEY)");
  sql.exec("DELETE FROM compact_snapshot_inputs");
  for (const id of inputJobs) sql.exec("INSERT INTO compact_snapshot_inputs (job_id) VALUES (?)", id);
}

export function restoreCompactSession(sql: SqlStorage): string[] {
  for (const table of [...TABLES.map(saved), "compact_snapshot_inputs"]) {
    if (!exists(sql, table)) throw new HttpError(500, "压缩恢复点不完整，未修改当前上下文。");
  }
  if (sql.exec("SELECT 1 FROM compact_snapshot_tasks WHERE status != 'terminal' LIMIT 1").toArray().length
    || sql.exec("SELECT 1 FROM compact_snapshot_submissions WHERE status IN ('queued', 'placed') LIMIT 1").toArray().length) throw new HttpError(409, "压缩恢复点包含未完成的任务，未恢复上下文。");
  for (const table of TABLES) sql.exec(`DELETE FROM ${table}`);
  for (const table of TABLES) sql.exec(`INSERT INTO ${table} SELECT * FROM ${saved(table)}`);
  sql.exec("CREATE TABLE IF NOT EXISTS restored_context_inputs (job_id TEXT PRIMARY KEY)");
  sql.exec("DELETE FROM restored_context_inputs");
  sql.exec("INSERT INTO restored_context_inputs SELECT * FROM compact_snapshot_inputs");
  return [...restoredInputJobs(sql)];
}

export function restoredInputJobs(sql: SqlStorage): Set<string> {
  return new Set(sql.exec<{ job_id: string }>("SELECT job_id FROM restored_context_inputs").toArray().map(row => row.job_id));
}

// Upgrade compatibility: an existing idle session still exactly at its latest
// manual compaction can become the first checkpoint without another model call.
export function currentCompactEntry(sql: SqlStorage): EntryId | undefined {
  if (!exists(sql, "entries")) return;
  const last = sql.exec<{ id: EntryId; kind: string; reason: string | null }>(`SELECT id, json_extract(record, '$.kind') AS kind, json_extract(record, '$.data.reason') AS reason
    FROM entries WHERE conversation_id = ? AND (json_type(record, '$.model') IS NOT NULL OR head IS NOT NULL)
    ORDER BY id DESC LIMIT 1`, ROOT_CONVERSATION_ID).toArray()[0];
  return last?.kind === "pi.compaction" && last.reason === "manual" && idleSession(sql) ? last.id : undefined;
}
