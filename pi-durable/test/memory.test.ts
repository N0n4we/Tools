import { describe, expect, it } from "vitest";
import { MemoryStore, validatePath } from "../src/memory/store.js";
import { agentExtension } from "../src/pi/extension.js";
import { memoryDatabase } from "./helpers.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

describe("Durable Object file memory", () => {
  it("loads persisted text and corrections through the prompt context", async () => {
    const { storage, files } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123", files);
    expect(await store.promptContext()).toBe("");
    files.writeFile("/hermes/123/MEMORY.md", "\ufeff中文偏好\n");
    expect(await new MemoryStore(storage, "hermes/123", files).promptContext()).toBe("### MEMORY.md\n\ufeff中文偏好\n");
    files.writeFile("/hermes/123/MEMORY.md", "用户修正\n");
    expect(await store.promptContext()).toBe("### MEMORY.md\n用户修正\n");
  });

  it("preserves nested Skills and their references", async () => {
    const { storage, files } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/", files);
    const content = "---\nname: archive-extraction\ndescription: 提取游戏归档\n---\n\n# Steps\n";
    files.writeFile("/hermes/123/skills/devops/archive-extraction/SKILL.md", content);
    files.writeFile("/hermes/123/skills/devops/archive-extraction/references/patterns.md", "解包模式");
    expect(await store.promptContext()).toContain(JSON.stringify([{ slug: "devops/archive-extraction", description: "提取游戏归档" }]));
    expect(files.readFile("/hermes/123/skills/devops/archive-extraction/SKILL.md").content).toBe(content);
    expect(files.readFile("/hermes/123/skills/devops/archive-extraction/references/patterns.md").content).toBe("解包模式");
  });

  it("ignores unsupported files, Skill symlinks and other namespaces", async () => {
    const { storage, files } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/", files);
    files.writeFile("/hermes/123/.MEMORY.md.recovery", "old data");
    files.writeFile("/hermes/123/sessions.db", "sqlite");
    files.writeFile("/hermes/123/skills/.hidden/SKILL.md", "hidden Skill");
    files.writeFile("/hermes/456/USER.md", "another owner");
    files.writeFile("/hermes/456/skills/other/SKILL.md", "another Skill");
    files.symlink("/hermes/456/skills/other/SKILL.md", "/hermes/123/skills/link/SKILL.md");
    expect(await store.promptContext()).toBe("");
  });

  it("discovers Skills after more than 500 reference files", async () => {
    const { storage, files } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/", files);
    for (let i = 0; i < 501; i++) files.writeFile(`/hermes/123/skills/a/references/${i}.md`, `# ${i}`);
    files.writeFile("/hermes/123/skills/z/SKILL.md", "---\ndescription: 最后的技能\n---\n正文");
    expect(await store.promptContext()).toContain(JSON.stringify([{ slug: "z", description: "最后的技能" }]));
  });

  it("injects memory and Skill context without registering file tools", async () => {
    const { storage, files } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/", files);
    files.writeFile("/hermes/123/MEMORY.md", "用户喜欢简洁回答");
    files.writeFile("/hermes/123/USER.md", "用户资料");
    files.writeFile("/hermes/123/STANDING.md", "常驻偏好");
    files.writeFile("/hermes/123/skills/nested/demo/SKILL.md", "---\ndescription: 测试技能简介\n---\n技能正文");
    const extension = agentExtension(store);
    expect(extension.tools ?? []).toEqual([]);
    const section = extension.sections![0]!;
    const text = await section.render({} as Parameters<typeof section.render>[0], BACKGROUND_CONTEXT);
    expect(text).toContain("### USER.md\n用户资料");
    for (const content of ["用户喜欢简洁回答", "用户资料", "常驻偏好", "nested/demo", "测试技能简介"]) expect(text).toContain(content);
    expect(text).not.toContain("技能正文");
    files.writeFile("/hermes/123/USER.md", "用户修正后的角色设定");
    expect(await section.render({} as Parameters<typeof section.render>[0], BACKGROUND_CONTEXT)).toContain("用户修正后的角色设定");
  });

  it("passes user memory through verbatim without rewriting the file", async () => {
    const { storage, files } = memoryDatabase();
    const legacy = "会话里的 [time] 显示的是 UTC 时间，回复时要换算成 UTC+8。";
    files.writeFile("/hermes/123/USER.md", legacy);
    const section = agentExtension(new MemoryStore(storage, "hermes/123/", files)).sections![0]!;
    const text = await section.render({} as Parameters<typeof section.render>[0], BACKGROUND_CONTEXT) as string;
    expect(text).toBe(`### USER.md\n${legacy}`);
    expect(files.readFile("/hermes/123/USER.md").content).toBe(legacy);
  });

  it.each(["../USER.md", "/USER.md", "skills/a/../b.md", "skills/a/.env", "skills/a\\b/SKILL.md", "skills//SKILL.md", "sessions.db", "skills/a/image.png", "skills/a/../../USER.md"]) ("rejects unsafe/unsupported path %s", (path) => {
    expect(() => validatePath(path)).toThrow();
  });

  it("limits the primary memory text included in prompts", async () => {
    const { storage, files } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/", files);
    files.writeFile("/hermes/123/MEMORY.md", "中".repeat(8001));
    expect(await store.promptContext()).toBe(`### MEMORY.md\n${"中".repeat(8000)}`);
  });

  it.each(["description: [broken", "description: [not, a, string]"])("keeps Skills discoverable with unsupported front matter: %s", async (metadata) => {
    const { storage, files } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/", files);
    files.writeFile("/hermes/123/skills/demo/SKILL.md", `---\n${metadata}\n---\n正文`);
    expect(await store.promptContext()).toContain(JSON.stringify([{ slug: "demo", description: "" }]));
  });

  it("rejects directories, symlinks and binary primary memory without changing the files", async () => {
    const { storage, files } = memoryDatabase();
    const store = new MemoryStore(storage, "hermes/123/", files);
    files.mkdir("/hermes/123/MEMORY.md");
    await expect(store.promptContext()).rejects.toMatchObject({ status: 400 });
    files.rm("/hermes/123/MEMORY.md", { recursive: true });
    files.writeFile("/hermes/123/target.txt", "do not change");
    files.symlink("target.txt", "/hermes/123/MEMORY.md");
    await expect(store.promptContext()).rejects.toMatchObject({ status: 400 });
    expect(files.readFile("/hermes/123/target.txt").content).toBe("do not change");
    files.rm("/hermes/123/MEMORY.md");
    files.writeFile("/hermes/123/MEMORY.md", new Uint8Array([0xff]));
    await expect(store.promptContext()).rejects.toMatchObject({ status: 400 });
    expect(files.readFileBuffer("/hermes/123/MEMORY.md").content).toEqual(new Uint8Array([0xff]));
  });
});
