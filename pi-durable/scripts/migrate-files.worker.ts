import type { FsObject } from "@stablemodels/durable-bash/object";
import { AgentBackend as RuntimeAgent } from "../src/agent.js";
import type { Env } from "../src/env.js";
import { ownerId } from "../src/env.js";
import { HttpError, errorResponse, secretsEqual } from "../src/http.js";
import { validatePath, type MemoryStorage } from "../src/memory/store.js";

function verifiedFiles(storage: MemoryStorage): number {
  return storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM hermes_text_files l JOIN files f
    ON f.path = '/' || l.namespace || l.path WHERE f.is_dir = 0 AND f.symlink_target IS NULL
    AND f.etag = l.etag AND COALESCE(f.content, X'') = CAST(l.content AS BLOB)
    AND f.size = length(CAST(l.content AS BLOB))`).toArray()[0]!.count;
}

export function migrateFiles(storage: MemoryStorage, files: Pick<FsObject, "exists" | "writeFile">) {
  return storage.transactionSync(() => {
    let migrated = 0;
    for (const file of storage.sql.exec<{ namespace: string; path: string; content: string; etag: string }>("SELECT namespace, path, content, etag FROM hermes_text_files")) {
      if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/$/.test(file.namespace)) throw new Error("Invalid legacy file namespace");
      const path = `/${file.namespace}${validatePath(file.path)}`;
      if (files.exists(path)) throw new HttpError(409, "Legacy file conflicts with the bash filesystem");
      files.writeFile(path, file.content);
      storage.sql.exec("UPDATE files SET etag = ? WHERE path = ?", file.etag, path);
      migrated++;
    }
    const verified = verifiedFiles(storage);
    if (verified !== migrated) throw new Error("Migrated file verification failed");
    // Keep the source table as a rollback copy; the production runtime never reads it.
    return { migrated, verified };
  });
}

function maintenance() { return new Response("File migration maintenance", { status: 503, headers: { "retry-after": "60" } }); }

export class AgentBackend extends RuntimeAgent {
  override async fetch(): Promise<Response> { return maintenance(); }
  override async alarm(): Promise<void> { await this.ctx.storage.setAlarm(Date.now() + 60_000); }
  migrateFiles(): Response {
    try { return Response.json(migrateFiles(this.ctx.storage, this), { headers: { "cache-control": "no-store" } }); }
    catch (error) { return errorResponse(error); }
  }
  migrationStatus() {
    const sql = this.ctx.storage.sql;
    const legacy = sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'hermes_text_files' AND type = 'table'").toArray().length > 0;
    return {
      legacyFiles: legacy ? sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM hermes_text_files").toArray()[0]!.count : null,
      files: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM files WHERE is_dir = 0 AND symlink_target IS NULL").toArray()[0]!.count,
      verified: legacy ? verifiedFiles(this.ctx.storage) : 0,
    };
  }
}

type MigrationEnv = Omit<Env, "AGENT"> & { AGENT: DurableObjectNamespace<AgentBackend> };

export default {
  async fetch(request: Request, env: MigrationEnv): Promise<Response> {
    try {
      if (new URL(request.url).pathname !== "/migrate-files" || !["GET", "POST"].includes(request.method)) return maintenance();
      if (!await secretsEqual(request.headers.get("x-telegram-bot-api-secret-token"), env.TELEGRAM_WEBHOOK_SECRET)) throw new HttpError(401, "Invalid migration secret");
      const agent = env.AGENT.get(env.AGENT.idFromName(ownerId(env)));
      return request.method === "POST" ? await agent.migrateFiles() : Response.json(await agent.migrationStatus(), { headers: { "cache-control": "no-store" } });
    } catch (error) { return errorResponse(error); }
  },
  async scheduled() {},
} satisfies ExportedHandler<MigrationEnv>;
