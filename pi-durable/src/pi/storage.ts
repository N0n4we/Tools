import { ROOT_CONVERSATION_ID, type EntryId } from "@earendil-works/pi-durable";

export { openDurableObjectSqliteStorage as openAgentStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

// shortcut: these are Pi Durable 1.3.0's session tables; review before upgrading.
// The caller must close its Harness and transactionally checkpoint the deletion.
export function discardAgentSession(sql: SqlStorage): void {
  for (const { name } of sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
    ('record_ids', 'conversations', 'entries', 'tasks', 'submissions', 'documents', 'document_revisions')`).toArray()) {
    sql.exec(`DELETE FROM "${name}"`);
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
