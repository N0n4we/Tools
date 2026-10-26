import { ROOT_CONVERSATION_ID, type EntryId } from "@earendil-works/pi-durable";
import type { FsObject } from "@stablemodels/durable-bash/object";
import { MAX_FILE_BYTES } from "../memory/store.js";

export { openDurableObjectSqliteStorage as openAgentStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

// shortcut: these are Pi Durable 1.3.0's session tables; review before upgrading.
// The caller must close its Harness and transactionally checkpoint the deletion.
export function discardAgentSession(sql: SqlStorage): void {
  for (const { name } of sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
    ('record_ids', 'conversations', 'entries', 'tasks', 'submissions', 'documents', 'document_revisions')`).toArray()) {
    sql.exec(`DELETE FROM "${name}"`);
  }
}

// The caller checkpoints the archive with its job before changing the session.
export function archiveAgentSession(sql: SqlStorage, files: Pick<FsObject, "mkdir" | "writeFile">, directory: string): void {
  const entries = sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'entries' AND type = 'table'").toArray().length
    ? sql.exec<{ record: string }>("SELECT record FROM entries ORDER BY id").toArray() : [];
  const bytes = new TextEncoder().encode(`[${entries.map(entry => entry.record).join(",")}]\n`);
  files.mkdir(directory.slice(0, directory.lastIndexOf("/")), { recursive: true });
  files.mkdir(directory);
  for (let start = 0, part = 0; start < bytes.length; part++) {
    let end = Math.min(start + MAX_FILE_BYTES, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    files.writeFile(`${directory}/context.json.part-${String(part).padStart(6, "0")}`, bytes.subarray(start, end));
    start = end;
  }
}

export function agentInput(sql: SqlStorage, requestId: string, entry?: EntryId): { entry: EntryId; after: EntryId | null } | undefined {
  if (!sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'submissions' AND type = 'table'").toArray().length) return;
  return sql.exec<{ entry: EntryId; after: EntryId | null }>(`SELECT e.id AS entry,
    (SELECT MAX(id) FROM entries WHERE conversation_id = e.conversation_id AND id < e.id
      AND json_extract(record, '$.kind') = 'pi.assistant') AS after
    FROM entries e WHERE e.conversation_id = ? AND e.id = COALESCE(?,
      (SELECT json_extract(record, '$.entry') FROM submissions WHERE conversation_id = ?
        AND json_extract(record, '$.type') = 'input' AND json_extract(record, '$.requestId') = ? ORDER BY id DESC LIMIT 1))
      AND json_extract(e.record, '$.kind') = 'pi.user' AND json_extract(e.record, '$.model[0].role') = 'user'
    LIMIT 1`, ROOT_CONVERSATION_ID, entry ?? null, ROOT_CONVERSATION_ID, requestId).toArray()[0];
}

// Keep entry identities for settled task/submission references, but remove their context and display payloads.
export function discardAgentReplies(sql: SqlStorage, entry: EntryId): void {
  sql.exec(`UPDATE entries SET head = NULL,
    record = json_set(json_remove(record, '$.model', '$.data', '$.head', '$.edits'), '$.kind', 'telegram.discarded')
    WHERE conversation_id = ? AND id > ?`, ROOT_CONVERSATION_ID, entry);
}
