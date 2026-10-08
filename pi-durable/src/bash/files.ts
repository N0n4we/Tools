import { FsObject } from "@stablemodels/durable-bash/object";
import { MAX_FILE_BYTES, type MemoryStorage } from "../memory/store.js";

// ponytail: these triggers use durable-bash 0.2.0's files schema; review them before upgrading.
export class AgentFiles extends FsObject {
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env as Record<string, unknown>);
    const storage: MemoryStorage = ctx.storage;
    const sql = storage.sql;
    storage.transactionSync(() => {
      if (!sql.exec<{ name: string }>("PRAGMA table_info(files)").toArray().some(column => column.name === "etag")) {
        sql.exec("ALTER TABLE files ADD COLUMN etag TEXT");
      }
      const revision = "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))";
      for (const event of ["INSERT", "UPDATE OF path, content, is_dir, symlink_target"]) {
        sql.exec(`CREATE TRIGGER IF NOT EXISTS files_revision_${event.split(" ")[0]} AFTER ${event} ON files
          BEGIN UPDATE files SET etag = ${revision} WHERE path = NEW.path; END`);
      }
      for (const event of ["INSERT", "UPDATE OF size"]) {
        sql.exec(`CREATE TRIGGER IF NOT EXISTS files_size_${event.split(" ")[0]} BEFORE ${event} ON files
          WHEN NEW.size > ${MAX_FILE_BYTES} BEGIN SELECT RAISE(ABORT, 'File is too large'); END`);
      }
      sql.exec(`UPDATE files SET etag = ${revision} WHERE etag IS NULL`);
    });
  }

  override cp(src: string, dest: string, options?: { recursive?: boolean }): void {
    this.ctx.storage.transactionSync(() => super.cp(src, dest, options));
  }

  override mv(src: string, dest: string): void {
    this.ctx.storage.transactionSync(() => super.mv(src, dest));
  }

  override rm(path: string, options?: { recursive?: boolean; force?: boolean }): void {
    this.ctx.storage.transactionSync(() => super.rm(path, options));
  }
}
