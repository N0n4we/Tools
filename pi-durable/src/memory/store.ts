import { parseDocument } from "yaml";
import { HttpError } from "../http.js";

const MEMORY_FILES = ["MEMORY.md", "USER.md", "failures.md", "STANDING.md"];
export const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 2_000;
const TEXT_EXTENSIONS = /\.(md|txt|json|yaml|yml|toml|sh|js|ts|py)$/i;

export type MemoryStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

export function validatePath(path: string): string {
  if (typeof path !== "string" || path.length > 512 || /[\\\x00-\x1f\x7f]/.test(path)) {
    throw new HttpError(400, "Invalid memory path");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part.startsWith(".") || part.includes(":"))) {
    throw new HttpError(400, "Unsafe memory path");
  }
  if (MEMORY_FILES.includes(path)) return path;
  if (parts[0] === "skills" && parts.length >= 3 && TEXT_EXTENSIONS.test(parts.at(-1)!)) return path;
  throw new HttpError(400, "Only primary memory files and Skill text files are allowed");
}

export class MemoryStore {
  readonly prefix: string;

  constructor(private readonly storage: MemoryStorage, prefix: string, files: { mkdir(path: string, options: { recursive: boolean }): void }) {
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

  private async read(path: string): Promise<string> {
    validatePath(path);
    const file = this.storage.sql.exec<{ content: ArrayBuffer | null; bytes: number; is_dir: number; symlink_target: string | null }>(
      "SELECT content, size AS bytes, is_dir, symlink_target FROM files WHERE path = ?", `/${this.prefix}${path}`,
    ).toArray()[0];
    if (!file) return "";
    if (file.is_dir || file.symlink_target !== null) throw new HttpError(400, "Memory path must be a regular file");
    if (file.bytes > MAX_FILE_BYTES) throw new HttpError(413, "Memory file is too large");
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.content ?? undefined);
    } catch { throw new HttpError(400, "Memory file must contain UTF-8 text"); }
  }

  private async list(): Promise<string[]> {
    const files = this.storage.sql.exec<{ path: string }>(
      "SELECT substr(path, ?) AS path FROM files WHERE substr(path, 1, ?) = ? AND is_dir = 0 AND symlink_target IS NULL ORDER BY path LIMIT ?",
      this.prefix.length + 2, this.prefix.length + 1, `/${this.prefix}`, MAX_FILES + 1,
    ).toArray();
    if (files.length > MAX_FILES) throw new HttpError(413, "Too many memory files");
    return files.map(file => file.path).filter(path => {
      try { validatePath(path); return true; } catch { return false; }
    }).sort((a, b) => a.localeCompare(b));
  }

  private async skills(): Promise<{ slug: string; description: string }[]> {
    const result = [];
    for (const path of await this.list()) {
      if (!path.startsWith("skills/") || !path.endsWith("/SKILL.md")) continue;
      const content = await this.read(path);
      const slug = path.slice("skills/".length, -"/SKILL.md".length);
      let description = "";
      if (content.startsWith("---\n")) {
        const end = content.indexOf("\n---", 4);
        if (end > 0 && end < 8_192) {
          try {
            const parsed: unknown = parseDocument(content.slice(4, end), { schema: "core" }).toJS({ maxAliasCount: 0 });
            if (parsed && typeof parsed === "object") {
              const meta = parsed as Record<string, unknown>;
              if (typeof meta.description === "string") description = meta.description.slice(0, 500);
            }
          } catch { /* Invalid front matter never prevents reading the original file. */ }
        }
      }
      result.push({ slug, description });
    }
    return result;
  }

  async promptContext(): Promise<string> {
    const sections = [];
    for (const path of ["USER.md", "MEMORY.md", "STANDING.md"]) {
      const content = await this.read(path);
      if (content) sections.push(`### ${path}\n${content.slice(0, 8_000)}`);
    }
    const skills = await this.skills();
    if (skills.length) sections.push(`### 可按需读取的 Skills\n${JSON.stringify(skills).slice(0, 8_000)}`);
    return sections.join("\n\n");
  }
}
