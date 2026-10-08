import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, vi } from "vitest";
import type { MemoryStorage } from "../src/memory/store.js";
import { AgentFiles } from "../src/bash/files.js";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {
  constructor(protected ctx: DurableObjectState, protected env: Record<string, unknown>) {}
} }));

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

// Use a real SQLite engine rather than interpreting production SQL in a mock.
// The workerd suite separately exercises Cloudflare's actual storage API.
export function memoryDatabase() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  let sequence = 0;
  const storage = {
    sql: {
      exec(sql: string, ...values: SQLInputValue[]) {
        const rows = database.prepare(sql).all(...values);
        return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
      },
    },
    transactionSync<T>(callback: () => T): T {
      const name = `test_transaction_${++sequence}`;
      database.exec(`SAVEPOINT ${name}`);
      try {
        const result = callback();
        database.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        throw error;
      }
    },
  };
  const durableStorage = storage as unknown as MemoryStorage;
  const files = new AgentFiles({ storage: durableStorage } as DurableObjectState, {});
  return { storage: durableStorage, database, files };
}
