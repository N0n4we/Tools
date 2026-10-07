import { SqliteStorage, type SqliteDatabase, type SqliteExecutor, type SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

// The npm 1.0.4 package has the portable SQLite core but does not yet export
// the Cloudflare adapter from upstream main. This small host adapter implements
// that public interface. Hermes texts have their own file table in this same
// Durable Object; no R2, native Hermes database or filesystem is required.
type Value = ArrayBuffer | string | number | null;

function bind(value: SqliteValue): Value {
  if (value instanceof Uint8Array) return value.slice().buffer as ArrayBuffer;
  if (typeof value !== "bigint") return value;
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("SQLite integer exceeds the JavaScript safe integer range");
  }
  return Number(value);
}

class Executor implements SqliteExecutor {
  constructor(private readonly storage: DurableObjectStorage, private readonly check: () => void = () => {}) {}

  private rows<T extends object>(sql: string, values: SqliteValue[]): T[] {
    this.check();
    return this.storage.sql.exec(sql, ...values.map(bind)).toArray().map((row) => {
      const normalized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) normalized[key] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      return normalized as T;
    });
  }
  async exec(sql: string): Promise<void> { this.check(); this.storage.sql.exec(sql); }
  async run(sql: string, ...values: SqliteValue[]): Promise<void> { this.check(); this.storage.sql.exec(sql, ...values.map(bind)); }
  async get<T extends object>(sql: string, ...values: SqliteValue[]): Promise<T | undefined> { return this.rows<T>(sql, values)[0]; }
  async all<T extends object>(sql: string, ...values: SqliteValue[]): Promise<T[]> { return this.rows<T>(sql, values); }
}

class Database implements SqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly executor: Executor;

  constructor(private readonly storage: DurableObjectStorage) { this.executor = new Executor(storage); }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  exec(sql: string) { return this.serial(() => this.executor.exec(sql)); }
  run(sql: string, ...values: SqliteValue[]) { return this.serial(() => this.executor.run(sql, ...values)); }
  get<T extends object>(sql: string, ...values: SqliteValue[]) { return this.serial(() => this.executor.get<T>(sql, ...values)); }
  all<T extends object>(sql: string, ...values: SqliteValue[]) { return this.serial(() => this.executor.all<T>(sql, ...values)); }
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.serial(() => this.storage.transaction(async () => {
      let active = true;
      const executor = new Executor(this.storage, () => { if (!active) throw new Error("Transaction is closed"); });
      try { return await callback(executor); } finally { active = false; }
    }));
  }
  close(): Promise<void> { return this.serial(async () => {}); }
}

export function openAgentStorage(storage: DurableObjectStorage): Promise<SqliteStorage> {
  return SqliteStorage.open(new Database(storage));
}
