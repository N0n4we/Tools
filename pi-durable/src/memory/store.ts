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
type FileWriter = { writeFile(path: string, content: string): void; mkdir(path: string, options: { recursive: boolean }): void };

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

  constructor(private readonly storage: MemoryStorage, prefix: string, private readonly files: FileWriter) {
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(prefix)) {
      throw new Error("MEMORY_PREFIX must contain only safe path segments");
    }
    this.prefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    files.mkdir(`/${this.prefix.slice(0, -1)}`, { recursive: true });
    for (const event of ["INSERT", "UPDATE OF path, is_dir"]) {
      storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS "files_count_${event.split(" ")[0]}_${this.prefix}" BEFORE ${event} ON files
        WHEN NEW.is_dir = 0 AND NEW.path GLOB '/${this.prefix}*'
        ${event.startsWith("UPDATE") ? `AND (OLD.is_dir != 0 OR OLD.path NOT GLOB '/${this.prefix}*')` : ""}
        AND (SELECT COUNT(*) FROM files WHERE is_dir = 0 AND path GLOB '/${this.prefix}*') >= ${MAX_FILES}
        BEGIN SELECT RAISE(ABORT, 'Too many memory files'); END`);
    }
  }

  async read(path: string): Promise<TextFile> {
    validatePath(path);
    const file = this.storage.sql.exec<{ content: ArrayBuffer | null; etag: string; bytes: number; is_dir: number; symlink_target: string | null }>(
      "SELECT content, etag, size AS bytes, is_dir, symlink_target FROM files WHERE path = ?", `/${this.prefix}${path}`,
    ).toArray()[0];
    if (!file) return { path, content: "", etag: null };
    if (file.is_dir || file.symlink_target !== null) throw new HttpError(400, "Memory path must be a regular file");
    if (file.bytes > MAX_FILE_BYTES) throw new HttpError(413, "Memory file is too large");
    try {
      return { path, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.content ?? undefined), etag: file.etag };
    } catch { throw new HttpError(400, "Memory file must contain UTF-8 text"); }
  }

  async write(path: string, content: string, expectedETag?: string | null): Promise<TextFile> {
    validatePath(path);
    if (typeof content !== "string") throw new HttpError(400, "content must be a string");
    const bytes = new TextEncoder().encode(content).byteLength;
    if (bytes > MAX_FILE_BYTES) throw new HttpError(413, "Memory file is too large");
    // Keep revision checks and writes atomic so concurrent tools cannot overwrite corrections.
    return this.storage.transactionSync(() => {
      const previous = this.storage.sql.exec<{ etag: string; is_dir: number; symlink_target: string | null }>(
        "SELECT etag, is_dir, symlink_target FROM files WHERE path = ?", `/${this.prefix}${path}`,
      ).toArray()[0];
      if (previous && (previous.is_dir || previous.symlink_target !== null)) throw new HttpError(400, "Memory path must be a regular file");
      if (previous && expectedETag === undefined) {
        throw new HttpError(412, "Read the file and supply its etag before replacing it");
      }
      if ((expectedETag ?? null) !== (previous?.etag ?? null)) {
        throw new HttpError(412, previous ? "Memory changed; read it again before writing" : "New file requires etag:null (JSON null, not a string)");
      }
      if (!previous) {
        const count = this.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM files WHERE substr(path, 1, ?) = ? AND is_dir = 0", this.prefix.length + 1, `/${this.prefix}`,
        ).toArray()[0]!.count;
        if (count >= MAX_FILES) throw new HttpError(413, "Too many memory files");
      }
      this.files.writeFile(`/${this.prefix}${path}`, content);
      const etag = this.storage.sql.exec<{ etag: string }>("SELECT etag FROM files WHERE path = ?", `/${this.prefix}${path}`).toArray()[0]!.etag;
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
      "SELECT substr(path, ?) AS path, etag, size FROM files WHERE substr(path, 1, ?) = ? AND is_dir = 0 AND symlink_target IS NULL ORDER BY path LIMIT ?",
      this.prefix.length + 2, this.prefix.length + 1, `/${this.prefix}`, MAX_FILES + 1,
    ).toArray();
    if (files.length > MAX_FILES) throw new HttpError(413, "Too many memory files");
    return files.filter(file => {
      try { validatePath(file.path); return true; } catch { return false; }
    }).sort((a, b) => a.path.localeCompare(b.path));
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
