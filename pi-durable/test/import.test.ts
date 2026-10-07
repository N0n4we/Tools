import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectMemoryFiles } from "../scripts/memory-files.mjs";

describe("read-only memory importer", () => {
  it("includes nested references, excludes databases/recovery/hidden files and never follows symlinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-import-test-"));
    try {
      await fs.mkdir(path.join(root, "skills", "devops", "extract", "references"), { recursive: true });
      for (const file of ["MEMORY.md", "USER.md", "failures.md", "sessions.db", ".MEMORY.md.recovery", "skills/devops/extract/SKILL.md", "skills/devops/extract/references/example.md", "skills/devops/extract/.env"]) await fs.writeFile(path.join(root, file), "test content\n");
      await fs.symlink("/etc/passwd", path.join(root, "skills", "devops", "extract", "private.md"));
      const files = await collectMemoryFiles(root);
      expect(files.map((file: { path: string }) => file.path).sort()).toEqual(["MEMORY.md", "USER.md", "failures.md", "skills/devops/extract/SKILL.md", "skills/devops/extract/references/example.md"]);
      expect(await fs.readFile(path.join(root, "MEMORY.md"), "utf8")).toBe("test content\n");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
