import { parseDocument } from "yaml";
import { HttpError } from "../http.js";

export const MEMORY_FILES = ["MEMORY.md", "USER.md", "failures.md", "STANDING.md"] as const;
export type MemoryFile = (typeof MEMORY_FILES)[number];
export const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 2_000;
const TEXT_EXTENSIONS = /\.(md|txt|json|yaml|yml|toml|sh|js|ts|py)$/i;

export interface TextFile {
  path: string;
  content: string;
  etag: string | null;
}

export type MemoryStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

export function validatePath(path: string): string {
  if (typeof path !== "string" || path.length > 512 || /[\\\x00-\x1f\x7f]/.test(path)) {
    throw new HttpError(400, "Invalid memory path");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part.startsWith(".") || part.includes(":"))) {
    throw new HttpError(400, "Unsafe memory path");
  }
  if ((MEMORY_FILES as readonly string[]).includes(path)) return path;
  if (parts[0] === "skills" && parts.length >= 3 && TEXT_EXTENSIONS.test(parts.at(-1)!)) return path;
  throw new HttpError(400, "Only primary memory files and Skill text files are allowed");
}

export function skillPath(slug: string, file = "SKILL.md"): string {
  return validatePath(`skills/${slug}/${file}`);
}

export interface SearchHit {
  path: string;
  line: number;
  score: number;
  text: string;
}

function terms(query: string): string[] {
  const normalized = query.normalize("NFKC").toLowerCase().trim();
  const words = normalized.split(/[\s，。；、,.;:!?！？]+/u).filter(Boolean);
  return [...new Set([normalized, ...words])].filter((term) => term.length > 0);
}

export function searchText(path: string, content: string, query: string): SearchHit[] {
  const needles = terms(query);
  const lines = content.split("\n");
  const hits: SearchHit[] = [];
  for (let start = 0; start < lines.length; start += 12) {
    const block = lines.slice(start, start + 12).join("\n");
    const normalized = block.normalize("NFKC").toLowerCase();
    let score = 0;
    let firstMatch = block.length;
    for (const needle of needles) {
      const index = normalized.indexOf(needle);
      if (index >= 0) { score += needle === needles[0] ? 10 : 3; firstMatch = Math.min(firstMatch, index); }
    }
    if (score > 0) {
      const offset = Math.max(0, firstMatch - 300);
      hits.push({ path, line: start + block.slice(0, offset).split("\n").length, score, text: block.slice(offset, offset + 2_000) });
    }
  }
  return hits;
}

export class MemoryStore {
  readonly prefix: string;

  constructor(private readonly storage: MemoryStorage, prefix: string) {
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(prefix)) {
      throw new Error("MEMORY_PREFIX must contain only safe path segments");
    }
    this.prefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    // Keep file paths and exact text independent of Pi's session tables. Using
    // SQL TEXT avoids the 128 KiB per-value limit of DO's get/put interface.
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS hermes_text_files (
      namespace TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      etag TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (namespace, path)
    )`);
  }

  async read(path: string): Promise<TextFile> {
    validatePath(path);
    const file = this.storage.sql.exec<{ content: string; etag: string; bytes: number }>(
      "SELECT content, etag, bytes FROM hermes_text_files WHERE namespace = ? AND path = ?", this.prefix, path,
    ).toArray()[0];
    if (!file) return { path, content: "", etag: null };
    if (file.bytes > MAX_FILE_BYTES) throw new HttpError(413, "Memory file is too large");
    return { path, content: file.content, etag: file.etag };
  }

  async write(path: string, content: string, expectedETag?: string | null): Promise<TextFile> {
    validatePath(path);
    if (typeof content !== "string") throw new HttpError(400, "content must be a string");
    const bytes = new TextEncoder().encode(content).byteLength;
    if (bytes > MAX_FILE_BYTES) throw new HttpError(413, "Memory file is too large");
    // No await between reading the revision and committing the update: both
    // API writes and model tools use this same DO and atomic transaction.
    return this.storage.transactionSync(() => {
      const previous = this.storage.sql.exec<{ etag: string }>(
        "SELECT etag FROM hermes_text_files WHERE namespace = ? AND path = ?", this.prefix, path,
      ).toArray()[0];
      if (previous && expectedETag === undefined) {
        throw new HttpError(412, "Read the file and supply its etag before replacing it");
      }
      if ((expectedETag ?? null) !== (previous?.etag ?? null)) {
        throw new HttpError(412, previous ? "Memory changed; read it again before writing" : "New file requires etag:null (JSON null, not a string)");
      }
      if (!previous) {
        const count = this.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM hermes_text_files WHERE namespace = ?", this.prefix,
        ).toArray()[0]!.count;
        if (count >= MAX_FILES) throw new HttpError(413, "Too many memory files");
      }
      // An opaque revision, not a content hash: even A -> B -> A invalidates
      // the old revision and cannot overwrite a correction with a stale read.
      const etag = crypto.randomUUID();
      this.storage.sql.exec(`INSERT INTO hermes_text_files (namespace, path, content, etag, bytes)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace, path) DO UPDATE SET content = excluded.content, etag = excluded.etag, bytes = excluded.bytes`,
      this.prefix, path, content, etag, bytes);
      return { path, content, etag };
    });
  }

  async append(path: MemoryFile, text: string): Promise<TextFile> {
    if (!text.trim()) throw new HttpError(400, "Cannot append empty memory");
    const previous = await this.read(path);
    const content = previous.content ? `${previous.content.trimEnd()}\n\n${text.trim()}\n` : `${text.trim()}\n`;
    return this.write(path, content, previous.etag);
  }

  async list(): Promise<{ path: string; etag: string; size: number }[]> {
    const files = this.storage.sql.exec<{ path: string; etag: string; size: number }>(
      "SELECT path, etag, bytes AS size FROM hermes_text_files WHERE namespace = ? ORDER BY path LIMIT ?", this.prefix, MAX_FILES + 1,
    ).toArray();
    if (files.length > MAX_FILES) throw new HttpError(413, "Too many memory files");
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async search(query: string, limit = 6, includeSkills = false): Promise<SearchHit[]> {
    if (!query.trim() || query.length > 200) throw new HttpError(400, "Invalid memory query");
    const paths = includeSkills
      ? (await this.list()).map((file) => file.path)
      : [...MEMORY_FILES];
    const hits: SearchHit[] = [];
    // Sequential reads keep peak memory bounded even with many Skill files.
    for (const path of paths) hits.push(...searchText(path, (await this.read(path)).content, query));
    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, Math.min(20, Math.max(1, limit)));
  }

  async skills(query = ""): Promise<{ slug: string; name: string; description: string; path: string; etag: string | null }[]> {
    const result = [];
    for (const file of await this.list()) {
      if (!file.path.startsWith("skills/") || !file.path.endsWith("/SKILL.md")) continue;
      const stored = await this.read(file.path);
      const slug = file.path.slice("skills/".length, -"/SKILL.md".length);
      let name = slug;
      let description = "";
      if (stored.content.startsWith("---\n")) {
        const end = stored.content.indexOf("\n---", 4);
        if (end > 0 && end < 8_192) {
          try {
            const parsed: unknown = parseDocument(stored.content.slice(4, end), { schema: "core" }).toJS({ maxAliasCount: 0 });
            if (parsed && typeof parsed === "object") {
              const meta = parsed as Record<string, unknown>;
              if (typeof meta.name === "string") name = meta.name.slice(0, 200);
              if (typeof meta.description === "string") description = meta.description.slice(0, 500);
            }
          } catch { /* Invalid front matter never prevents reading the original file. */ }
        }
      }
      if (!query || `${slug}\n${name}\n${description}`.toLowerCase().includes(query.toLowerCase())) {
        result.push({ slug, name, description, path: file.path, etag: stored.etag });
      }
    }
    return result;
  }

  async promptContext(): Promise<string> {
    const sections = [];
    for (const path of ["USER.md", "MEMORY.md", "STANDING.md"]) {
      const file = await this.read(path);
      if (file.content) sections.push(`### ${path}\n${file.content.slice(0, 8_000)}`);
    }
    const skills = await this.skills();
    if (skills.length) sections.push(`### 可按需读取的 Skills\n${JSON.stringify(skills.map(({ slug, description }) => ({ slug, description }))).slice(0, 8_000)}`);
    return sections.join("\n\n");
  }
}
