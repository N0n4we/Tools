import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { memoryDatabase } from "./helpers.js";
import { AgentFiles } from "../src/bash/files.js";
import { migrateFiles } from "../scripts/migrate-files.worker.js";
import { bashExtension } from "../src/bash/extension.js";
import { MAX_FILE_BYTES, MemoryStore } from "../src/memory/store.js";

function fixture() {
  const { storage, files, database } = memoryDatabase();
  const store = new MemoryStore(storage, "hermes/123/", files);
  const tool = bashExtension(files, "/hermes/123").tools![0]!;
  const output: string[] = [];
  const api = { output: (text: string) => output.push(text) } as Parameters<typeof tool.execute>[1];
  const run = (command: string, timeout?: number, context = BACKGROUND_CONTEXT) => tool.execute({ command, timeout }, api, context);
  return { storage, files, database, store, tool, output, run };
}

function legacyTable(database: ReturnType<typeof memoryDatabase>["database"]) {
  database.exec("CREATE TABLE hermes_text_files (namespace TEXT, path TEXT, content TEXT, etag TEXT, bytes INTEGER, PRIMARY KEY(namespace, path))");
  return database.prepare("INSERT INTO hermes_text_files VALUES (?, ?, ?, ?, ?)");
}

describe("durable-bash filesystem and Pi tool", () => {
  it("shares exact memory and nested Skill files with shell scripts, pipes and globbing", async () => {
    const { store, files, output, run } = fixture();
    await store.write("MEMORY.md", "用户喜欢简洁回答\n", null);
    await store.write("skills/demo/scripts/check.sh", "printf '脚本输出\\n'", null);
    await run("cat MEMORY.md | grep 简洁; bash skills/demo/scripts/check.sh; cat <<'EOF' > skills/demo/SKILL.md\n---\nname: demo\ndescription: 测试技能\n---\n# 中文技能\nEOF\ncat skills/demo/*.md");
    expect(output.join("")).toContain("用户喜欢简洁回答\n脚本输出\n");
    expect(output.join("")).toContain("# 中文技能");
    expect((await store.skills())[0]).toMatchObject({ slug: "demo", description: "测试技能" });
    files.writeFile("/hermes/123/notes.csv", "1,2");
    expect((await store.list()).map(file => file.path)).not.toContain("notes.csv");
  });

  it("invalidates revisions for append, copy, rename, delete and A -> B -> A shell writes", async () => {
    const { store, run } = fixture();
    const first = await store.write("USER.md", "A", null);
    for (const command of ["printf B >> USER.md", "cp USER.md backup.txt; mv backup.txt USER.md", "printf B > USER.md; printf A > USER.md", "rm USER.md; printf A > USER.md"]) {
      const previous = await store.read("USER.md");
      await run(command);
      expect((await store.read("USER.md")).etag).not.toBe(previous.etag);
      await expect(store.write("USER.md", "stale", previous.etag)).rejects.toMatchObject({ status: 412 });
    }
    expect((await store.read("USER.md")).content).toBe("A");
    expect((await store.read("USER.md")).etag).not.toBe(first.etag);
  });

  it("rejects oversized shell writes without changing the previous contents or revision", async () => {
    const { store, run } = fixture();
    const previous = await store.write("MEMORY.md", "x".repeat(MAX_FILE_BYTES), null);
    await expect(run("printf x >> MEMORY.md")).rejects.toThrow("File is too large");
    expect(await store.read("MEMORY.md")).toEqual(previous);
  });

  it("enforces the namespace file cap for shell writes and still allows updates", async () => {
    const { files, store, run } = fixture();
    for (let i = 0; i < 2000; i++) files.writeFile(`/hermes/123/skills/s${i}/SKILL.md`, "x");
    await expect(run("echo new > USER.md")).rejects.toThrow("Too many memory files");
    expect((await store.read("USER.md")).etag).toBeNull();
    await run("echo corrected > skills/s0/SKILL.md");
    expect((await store.read("skills/s0/SKILL.md")).content).toBe("corrected\n");
  });

  it("does not inherit host secrets, run native programs or enable networking", async () => {
    const { run, output } = fixture();
    process.env.DURABLE_BASH_TEST_SECRET = "not-for-the-shell";
    try {
      await run("echo \"$DURABLE_BASH_TEST_SECRET\"");
      expect(output.join("")).not.toContain("not-for-the-shell");
      for (const command of ["node -v", "python -V", "curl https://example.com"]) await expect(run(command)).rejects.toThrow("Command exited");
    } finally { delete process.env.DURABLE_BASH_TEST_SECRET; }
  });

  it("stops writes after timeout or invocation cancellation", async () => {
    const { store, run } = fixture();
    await expect(run("sleep 1; echo late > USER.md", 0.01)).rejects.toThrow();
    const controller = new AbortController();
    const pending = run("sleep 1; echo late > MEMORY.md", 1, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await store.read("USER.md")).etag).toBeNull();
    expect((await store.read("MEMORY.md")).etag).toBeNull();
  });

  it("retains stdout and stderr for a nonzero exit", async () => {
    const { run, output } = fixture();
    await expect(run("printf visible; printf error >&2; exit 7")).rejects.toThrow("Command exited with code 7");
    expect(output.join("")).toBe("visibleerror");
  });

  it("resets the shell environment and cwd between calls, but keeps files", async () => {
    const { run, output } = fixture();
    await run("export TEMP_VALUE=secret; mkdir work; cd work; echo persistent > file.txt");
    await run("pwd; printf '%s' \"$TEMP_VALUE\"; cat work/file.txt");
    expect(output.join("")).toBe("/hermes/123\npersistent\n");
  });

  it("rejects invalid commands and timeouts at the Pi tool boundary", () => {
    const { tool } = fixture();
    for (const args of [{ command: "" }, { command: "x".repeat(32_001) }, ...[0, -1, 61].map(timeout => ({ command: "true", timeout }))]) {
      expect(() => validateToolArguments(tool, { type: "toolCall", id: "bash-test", name: "bash", arguments: args })).toThrow();
    }
  });

  it("rejects directories and symbolic links as memory files without overwriting their targets", async () => {
    const { store, run } = fixture();
    await run("echo target > target.txt; ln -s target.txt USER.md; mkdir MEMORY.md");
    for (const path of ["USER.md", "MEMORY.md"]) {
      await expect(store.read(path)).rejects.toMatchObject({ status: 400 });
      await expect(store.write(path, "wrong", null)).rejects.toMatchObject({ status: 400 });
    }
  });

  it.each([["a_b", "axb"], ["a%b", "axxb"], ["A", "a"], ["🙂", "🙂x"]])("keeps directory operations for %s isolated from %s", (name, sibling) => {
    const { files } = fixture();
    const source = `/hermes/123/skills/${name}`;
    const other = `/hermes/123/skills/${sibling}/other.md`;
    files.writeFile(`${source}/own.md`, "own");
    files.writeFile(other, "do not touch");
    expect(files.readdir(source)).toEqual(["own.md"]);
    expect(files.readdirWithFileTypes(source).map(entry => entry.name)).toEqual(["own.md"]);
    files.cp(source, "/copy", { recursive: true });
    expect(files.readdir("/copy")).toEqual(["own.md"]);
    files.mv(source, "/moved");
    expect(files.readFile(other).content).toBe("do not touch");
    files.cp("/copy", source, { recursive: true });
    files.rm(source, { recursive: true });
    expect(files.readFile(other).content).toBe("do not touch");
  });

  it("rolls back multi-file copies and moves when the namespace cap is reached", () => {
    const { files } = fixture();
    for (let i = 0; i < 1999; i++) files.writeFile(`/hermes/123/skills/s${i}/SKILL.md`, "x");
    files.writeFile("/stash/pair/one.txt", "one");
    files.writeFile("/stash/pair/two.txt", "two");
    expect(() => files.cp("/stash/pair", "/hermes/123/skills/copied", { recursive: true })).toThrow("Too many memory files");
    expect(files.exists("/hermes/123/skills/copied")).toBe(false);
    expect(() => files.mv("/stash/pair", "/hermes/123/skills/moved")).toThrow("Too many memory files");
    expect(files.exists("/hermes/123/skills/moved")).toBe(false);
    expect(files.readdir("/stash/pair")).toEqual(["one.txt", "two.txt"]);
  });

  it("preserves UTF-8 BOMs and rejects binary memory instead of silently corrupting it", async () => {
    const { files, store, run, output } = fixture();
    const content = "\ufeff中文记忆\n";
    await store.write("MEMORY.md", content, null);
    expect((await store.read("MEMORY.md")).content).toBe(content);
    await run("cat MEMORY.md");
    expect(output.join("")).toBe(content);
    files.writeFile("/hermes/123/USER.md", new Uint8Array([0xff]));
    await expect(store.read("USER.md")).rejects.toMatchObject({ status: 400 });
    expect(files.readFileBuffer("/hermes/123/USER.md").content).toEqual(new Uint8Array([0xff]));
  });

  it("does not auto-migrate on startup; manual migration preserves text, revisions and the source", async () => {
    const { storage, files, database } = memoryDatabase();
    const insert = legacyTable(database);
    const content = "😀\n".repeat(50_000) + "x".repeat(MAX_FILE_BYTES - 250_000);
    const etag = crypto.randomUUID();
    insert.run("hermes/123/", "MEMORY.md", content, etag, MAX_FILE_BYTES);
    insert.run("hermes/123/", "skills/nested/demo/SKILL.md", "", crypto.randomUUID(), 0);
    insert.run("hermes/456/", "USER.md", "另一用户", crypto.randomUUID(), 12);
    new AgentFiles({ storage } as DurableObjectState, {});
    const store = new MemoryStore(storage, "hermes/123/", files);
    expect((await store.read("MEMORY.md")).etag).toBeNull();
    expect(migrateFiles(storage, files)).toEqual({ migrated: 3, verified: 3 });
    expect(await store.read("MEMORY.md")).toMatchObject({ content, etag });
    expect((await store.read("skills/nested/demo/SKILL.md")).etag).not.toBeNull();
    expect(files.readFile("/hermes/456/USER.md").content).toBe("另一用户");
    expect(database.prepare("SELECT COUNT(*) AS count FROM hermes_text_files").get()).toMatchObject({ count: 3 });
    new AgentFiles({ storage } as DurableObjectState, {});
    expect((await store.read("MEMORY.md")).etag).toBe(etag);
  });

  it("rolls back the entire migration on conflict instead of overwriting either copy", () => {
    const { storage, files, database } = memoryDatabase();
    const insert = legacyTable(database);
    insert.run("hermes/123/", "MEMORY.md", "legacy memory", crypto.randomUUID(), 13);
    insert.run("hermes/123/", "USER.md", "legacy user", crypto.randomUUID(), 11);
    files.writeFile("/hermes/123/USER.md", "existing correction");
    expect(() => migrateFiles(storage, files)).toThrow("conflicts");
    expect(files.exists("/hermes/123/MEMORY.md")).toBe(false);
    expect(files.readFile("/hermes/123/USER.md").content).toBe("existing correction");
    expect(database.prepare("SELECT COUNT(*) AS count FROM hermes_text_files").get()).toMatchObject({ count: 2 });
  });

  it("makes the migration CLI read-only unless explicitly confirmed, without logging the secret", () => {
    const preload = `import assert from 'node:assert/strict'; globalThis.fetch = async (url, options) => {
      assert.equal(url.href, 'https://agent.workers.dev/migrate-files');
      assert.equal(options.method, process.argv.includes('--confirm') ? 'POST' : 'GET');
      assert.equal(options.headers['x-telegram-bot-api-secret-token'], 'fixture-secret');
      return Response.json({ checked: true });
    };`;
    for (const flags of [[], ["--confirm"]]) {
      const output = execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "scripts/migrate-files.mjs", "--url", "https://agent.workers.dev/migrate-files", ...flags], { encoding: "utf8", env: { ...process.env, TELEGRAM_WEBHOOK_SECRET: "fixture-secret" } });
      expect(output).toContain('{"checked":true}');
      expect(output).not.toContain("fixture-secret");
      expect(output.includes("Status only")).toBe(flags.length === 0);
    }
  });
});
