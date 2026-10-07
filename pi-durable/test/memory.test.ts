import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, MemoryStore, searchText, skillPath, validatePath } from "../src/memory/store.js";
import { memoryExtension } from "../src/memory/extension.js";
import { memoryDatabase } from "./helpers.js";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

describe("Durable Object file memory", () => {
  it("persists the exact text and enforces revision checks", async () => {
    const { storage } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123");
    expect((await store.read("MEMORY.md")).etag).toBeNull();
    const first = await store.write("MEMORY.md", "中文偏好\n", null);
    expect((await new MemoryStore(storage, "hermes/123").read("MEMORY.md")).content).toBe("中文偏好\n");
    await expect(store.write("MEMORY.md", "overwrite")).rejects.toMatchObject({ status: 412 });
    const updated = await store.write("MEMORY.md", "用户修正\n", first.etag);
    await expect(store.write("MEMORY.md", "stale", first.etag)).rejects.toMatchObject({ status: 412 });
    expect((await store.read("MEMORY.md")).etag).toBe(updated.etag);
    expect((await store.read("MEMORY.md")).content).toBe("用户修正\n");
  });

  it("atomically admits just one of two writes with the same revision", async () => {
    const { storage } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/");
    const first = await store.write("USER.md", "first", null);
    const other = new MemoryStore(storage, "hermes/123/");
    const results = await Promise.allSettled([
      other.write("USER.md", "user changed it", first.etag),
      store.write("USER.md", "agent update", first.etag),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { status: 412 } });
    expect((await store.read("USER.md")).content).toBe("user changed it");
  });

  it("appends and searches Chinese without native Hermes or session search", async () => {
    const { storage } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/");
    await store.append("MEMORY.md", "用户喜欢简洁回答");
    await store.append("MEMORY.md", "Python 使用 uv");
    expect((await store.search("简洁"))[0]?.path).toBe("MEMORY.md");
    expect((await store.search("PYTHON"))[0]?.text).toContain("uv");
    expect(await store.search("不存在的词")).toEqual([]);
  });

  it("preserves nested Skills and their references", async () => {
    const { storage } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/");
    const content = "---\nname: archive-extraction\ndescription: 提取游戏归档\n---\n\n# Steps\n";
    await store.write(skillPath("devops/archive-extraction"), content, null);
    await store.write(skillPath("devops/archive-extraction", "references/patterns.md"), "解包模式", null);
    const skills = await store.skills("归档");
    expect(skills[0]).toMatchObject({ slug: "devops/archive-extraction", name: "archive-extraction", description: "提取游戏归档" });
    expect((await store.read(skills[0]!.path)).content).toBe(content);
    expect((await store.search("解包", 6, true))[0]?.path).toContain("references/patterns.md");
  });

  it("rejects recovery/database files and isolates namespaces", async () => {
    const { storage } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/");
    await expect(store.write(".MEMORY.md.recovery", "old data", null)).rejects.toMatchObject({ status: 400 });
    await expect(store.write("sessions.db", "sqlite", null)).rejects.toMatchObject({ status: 400 });
    await new MemoryStore(storage, "hermes/456/").write("USER.md", "another owner", null);
    expect(await store.list()).toEqual([]);
    expect((await store.read("USER.md")).content).toBe("");
  });

  it("lists metadata for more than 500 files without loading their contents", async () => {
    const { storage } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/");
    for (let i = 0; i < 501; i++) await store.write(`skills/s${i}/SKILL.md`, `# ${i}`, null);
    const list = await store.list();
    expect(list).toHaveLength(501);
    expect(list[0]).toMatchObject({ path: "skills/s0/SKILL.md", size: 3 });
    expect(list[0]).not.toHaveProperty("content");
  });

  it("registers real Durable tools, not CLI extension factories", () => {
    const { storage } = memoryDatabase();
    const extension = memoryExtension(new MemoryStore(storage, "hermes/123/"));
    expect(extension.tools?.map((tool) => tool.name)).toEqual(["memory_read", "memory_search", "memory_append", "memory_replace", "skill_list", "skill_read", "skill_save"]);
  });

  it("distinguishes a missing Skill from a real empty file without changing new memory semantics", async () => {
    const { storage } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/");
    const extension = memoryExtension(store);
    const tool = extension.tools!.find((tool) => tool.name === "skill_read")!;
    const api = {} as Parameters<typeof tool.execute>[1];
    const missing = await tool.execute({ slug: "missing" }, api, BACKGROUND_CONTEXT);
    expect(missing).toMatchObject({ isError: true });
    expect(missing.content).toEqual([{ type: "text", text: JSON.stringify({ error: "Skill file does not exist; call skill_list and use its slug, with a relative file path" }) }]);
    const empty = await store.write("skills/empty/SKILL.md", "", null);
    const existing = await tool.execute({ slug: "empty" }, api, BACKGROUND_CONTEXT);
    expect(existing).not.toMatchObject({ isError: true });
    expect(existing.content).toEqual([{ type: "text", text: JSON.stringify(empty) }]);
    expect(await store.read("USER.md")).toMatchObject({ content: "", etag: null });
  });

  it("preserves valid revisions and lets Pi normalize a model's string null to JSON null", () => {
    const { storage } = memoryDatabase();
    const extension = memoryExtension(new MemoryStore(storage, "hermes/123/"));
    for (const name of ["skill_save", "memory_replace"]) {
      const tool = extension.tools!.find((tool) => tool.name === name)!;
      const args = name === "skill_save" ? { slug: "test", content: "fixture" } : { path: "MEMORY.md", content: "fixture" };
      const validate = (etag: string | null) => validateToolArguments(tool, { type: "toolCall", id: "revision-test", name, arguments: { ...args, etag } });
      expect(validate(null)).toMatchObject({ etag: null });
      expect(validate("01234567-89ab-4cde-8f01-234567890abc")).toMatchObject({ etag: "01234567-89ab-4cde-8f01-234567890abc" });
      expect(validate("null")).toMatchObject({ etag: null });
      expect(() => validate("invalid-revision")).toThrow();
    }
  });

  it.each(["../USER.md", "/USER.md", "skills/a/../b.md", "skills/a/.env", "skills/a\\b/SKILL.md", "skills//SKILL.md", "sessions.db", "skills/a/image.png", "skills/a/../../USER.md"]) ("rejects unsafe/unsupported path %s", (path) => {
    expect(() => validatePath(path)).toThrow();
  });

  it("returns line-based snippets and limits the file size", async () => {
    expect(searchText("MEMORY.md", "hello\nworld", "WORLD")[0]).toMatchObject({ line: 1, score: 10 });
    const { storage } = memoryDatabase();
    await expect(new MemoryStore(storage, "hermes/123/").write("MEMORY.md", "中".repeat(100_000), null)).rejects.toMatchObject({ status: 413 });
  });

  it("retrieves matches after the first 2,000 characters of a long line", () => {
    const hits = searchText("MEMORY.md", "旧资料".repeat(2000) + "真正需要的关键词", "关键词");
    expect(hits[0]?.text).toContain("关键词");
  });

  it("preserves the full 256 KiB file limit rather than hitting DO KV's 128 KiB limit", async () => {
    const { storage } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/");
    const content = "😀\n".repeat(50_000) + "x".repeat(MAX_FILE_BYTES - 250_000);
    const first = await store.write("MEMORY.md", content, null);
    expect((await store.read("MEMORY.md")).content === content).toBe(true);
    expect((await store.list())[0]?.size).toBe(MAX_FILE_BYTES);
    await expect(store.write("MEMORY.md", content + "x", first.etag)).rejects.toMatchObject({ status: 413 });
    expect((await store.read("MEMORY.md")).etag).toBe(first.etag);
  });

  it("rejects conflicting file creation and stale A -> B -> A revisions", async () => {
    const { storage } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/");
    const a = await store.write("MEMORY.md", "A", null);
    await expect(store.write("MEMORY.md", "other", null)).rejects.toMatchObject({ status: 412 });
    const b = await store.write("MEMORY.md", "B", a.etag);
    const nextA = await store.write("MEMORY.md", "A", b.etag);
    expect(nextA.etag).not.toBe(a.etag);
    await expect(store.write("MEMORY.md", "stale", a.etag)).rejects.toMatchObject({ status: 412 });
  });

  it("enforces the file cap on creation without preventing existing-file updates", async () => {
    const { storage } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/");
    for (let i = 0; i < 2000; i++) await store.write(`skills/s${i}/SKILL.md`, `# ${i}`, null);
    await expect(store.write("USER.md", "new", null)).rejects.toMatchObject({ status: 413 });
    const first = await store.read("skills/s0/SKILL.md");
    await expect(store.write(first.path, "corrected", first.etag)).resolves.toMatchObject({ content: "corrected" });
    await expect(new MemoryStore(storage, "other/").write("USER.md", "new", null)).resolves.toMatchObject({ content: "new" });
  });
});
