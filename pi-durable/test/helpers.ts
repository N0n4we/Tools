import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach } from "vitest";
import type { MemoryStorage } from "../src/memory/store.js";

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
        return { toArray: () => rows };
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
  return { storage: storage as unknown as MemoryStorage, database };
}
