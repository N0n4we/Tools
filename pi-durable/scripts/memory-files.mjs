import fs from "node:fs/promises";
import path from "node:path";

const primary = new Set(["MEMORY.md", "USER.md", "failures.md", "STANDING.md"]);
const extensions = /\.(md|txt|json|yaml|yml|toml|sh|js|ts|py)$/i;
const maxBytes = 256 * 1024;

export async function collectMemoryFiles(source) {
  const root = await fs.realpath(source);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("--source must be a directory");
  const files = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      // Never import native databases, locks, recovery files, AppleDouble files,
      // credentials or symlinks; do not modify or delete any source files.
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (relative === "skills" || relative.startsWith("skills/")) await walk(absolute);
      } else if (entry.isFile() && (primary.has(relative) || (relative.startsWith("skills/") && relative.split("/").length >= 3 && extensions.test(relative)))) {
        const real = await fs.realpath(absolute);
        if (!real.startsWith(`${root}${path.sep}`)) throw new Error("Source path escaped its root");
        const bytes = await fs.readFile(real);
        if (bytes.length > maxBytes) throw new Error(`File exceeds 256 KiB: ${relative}`);
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (content.includes("\0")) throw new Error(`Not a text file: ${relative}`);
        files.push({ path: relative, content, bytes: bytes.length });
        if (files.length > 2000) throw new Error("Too many memory files");
      }
    }
  }
  await walk(root);
  return files;
}
