export { openDurableObjectSqliteStorage as openAgentStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

// shortcut: these are Pi Durable 1.3.0's session tables; review before upgrading.
// The caller must close its Harness and transactionally checkpoint the deletion.
export function discardAgentSession(sql: SqlStorage): void {
  for (const { name } of sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
    ('record_ids', 'conversations', 'entries', 'tasks', 'submissions', 'documents', 'document_revisions')`).toArray()) {
    sql.exec(`DELETE FROM "${name}"`);
  }
}
