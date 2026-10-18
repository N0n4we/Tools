import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { memoryDatabase } from "./helpers.js";
import { AgentFiles } from "../src/bash/files.js";
import { migrateFiles } from "../scripts/migrate-files.worker.js";
import { bashExtension } from "../src/bash/extension.js";
import { MAX_FILE_BYTES, MemoryStore } from "../src/memory/store.js";
import { installSpeechSkill } from "../src/speech/skill.js";
import { MAX_WEB_BYTES, WebAccess } from "../src/web/access.js";

function fixture(web = new WebAccess({}, vi.fn(async () => { throw new Error("Unexpected network request"); }) as unknown as typeof fetch)) {
  const { storage, files, database } = memoryDatabase();
  const store = new MemoryStore(storage, "hermes/123/", files);
  const revision = (path: string) => storage.sql.exec<{ etag: string }>("SELECT etag FROM files WHERE path = ?", `/hermes/123/${path}`).toArray()[0]?.etag ?? null;
  const tool = bashExtension(files, "/hermes/123", web).tools![0]!;
  const output: string[] = [];
  const api = {
    output: (text: string) => output.push(text),
  } as Parameters<typeof tool.execute>[1];
  const run = (command: string, timeout?: number, context = BACKGROUND_CONTEXT) => tool.execute({ command, timeout }, api, context);
  return { storage, files, database, store, tool, output, run, revision };
}

function legacyTable(database: ReturnType<typeof memoryDatabase>["database"]) {
  database.exec("CREATE TABLE hermes_text_files (namespace TEXT, path TEXT, content TEXT, etag TEXT, bytes INTEGER, PRIMARY KEY(namespace, path))");
  return database.prepare("INSERT INTO hermes_text_files VALUES (?, ?, ?, ?, ?)");
}

describe("durable-bash filesystem and Pi tool", () => {
  it("installs the speech Skill once, advertises only its description and reads its body through bash", async () => {
    const { storage, files, store, output, run, revision } = fixture();
    installSpeechSkill(storage, files, store.prefix);
    const etag = revision("skills/telegram-speech/SKILL.md");
    expect(etag).not.toBeNull();
    const prompt = await store.promptContext();
    expect(prompt).toContain(JSON.stringify({ slug: "telegram-speech", description: "用户明确要求生成语音、朗读文字或用语音回复时使用。" }));
    expect(prompt).not.toContain("若回执不确定");
    await run("cat skills/telegram-speech/SKILL.md");
    expect(output.join("")).toContain("调用 telegram_speak");
    expect(output.join("")).toContain("不能自动重试或声称已送达");
    installSpeechSkill(storage, files, store.prefix);
    expect(revision("skills/telegram-speech/SKILL.md")).toBe(etag);
  });

  it.each(["", "用户修正的语音 Skill"])("preserves existing speech Skill content and revision: %j", content => {
    const { storage, files, store, revision } = fixture();
    const path = "/hermes/123/skills/telegram-speech/SKILL.md";
    files.writeFile(path, content);
    const etag = revision("skills/telegram-speech/SKILL.md");
    installSpeechSkill(storage, files, store.prefix);
    expect(files.readFile(path).content).toBe(content);
    expect(revision("skills/telegram-speech/SKILL.md")).toBe(etag);
  });

  it.each(["skills", "skills/telegram-speech", "skills/telegram-speech/SKILL.md"])("leaves symlink collisions untouched at %s", path => {
    const { storage, files, store } = fixture();
    files.writeFile("/elsewhere/SKILL.md", "do not change");
    const target = path.endsWith("SKILL.md") ? "/elsewhere/SKILL.md" : "/elsewhere";
    files.symlink(target, `/hermes/123/${path}`);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try { installSpeechSkill(storage, files, store.prefix); }
    finally { warning.mockRestore(); }
    expect(files.readlink(`/hermes/123/${path}`)).toBe(target);
    expect(files.readFile("/elsewhere/SKILL.md").content).toBe("do not change");
    if (!path.endsWith("SKILL.md")) expect(files.exists("/hermes/123/skills/telegram-speech/SKILL.md")).toBe(false);
  });

  it("skips speech Skill initialization atomically when the memory file quota is full", () => {
    const { storage, files, store } = fixture();
    for (let i = 0; i < 2000; i++) files.writeFile(`/hermes/123/skills/s${i}/SKILL.md`, "keep");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => installSpeechSkill(storage, files, store.prefix)).not.toThrow();
      expect(warning).toHaveBeenCalledWith("Could not initialize telegram-speech Skill");
    } finally { warning.mockRestore(); }
    expect(files.exists("/hermes/123/skills/telegram-speech")).toBe(false);
    expect(files.readFile("/hermes/123/skills/s0/SKILL.md").content).toBe("keep");
  });

  it("shares exact memory and nested Skill files with shell scripts, pipes and globbing", async () => {
    const { store, files, output, run } = fixture();
    files.writeFile("/hermes/123/MEMORY.md", "用户喜欢简洁回答\n");
    files.writeFile("/hermes/123/skills/demo/scripts/check.sh", "printf '脚本输出\\n'");
    await run("cat MEMORY.md | grep 简洁; bash skills/demo/scripts/check.sh; cat <<'EOF' > skills/demo/SKILL.md\n---\nname: demo\ndescription: 测试技能\n---\n# 中文技能\nEOF\ncat skills/*/*.md");
    expect(output.join("")).toContain("用户喜欢简洁回答\n脚本输出\n");
    expect(output.join("")).toContain("# 中文技能");
    expect(await store.promptContext()).toContain(JSON.stringify({ slug: "demo", description: "测试技能" }));
    files.writeFile("/hermes/123/notes.csv", "1,2");
    expect(await store.promptContext()).not.toContain("notes.csv");
  });

  it("invalidates revisions for append, copy, rename, delete and A -> B -> A shell writes", async () => {
    const { files, run, revision } = fixture();
    files.writeFile("/hermes/123/USER.md", "A");
    const first = revision("USER.md");
    for (const command of ["printf B >> USER.md", "cp USER.md backup.txt; mv backup.txt USER.md", "printf B > USER.md; printf A > USER.md", "rm USER.md; printf A > USER.md"]) {
      const previous = revision("USER.md");
      await run(command);
      expect(revision("USER.md")).not.toBe(previous);
    }
    expect(files.readFile("/hermes/123/USER.md").content).toBe("A");
    expect(revision("USER.md")).not.toBe(first);
  });

  it("reports missing Skill files as errors but reads real empty files", async () => {
    const { run } = fixture();
    await expect(run("cat skills/missing/SKILL.md")).rejects.toThrow("Command exited");
    await run("mkdir -p skills/empty; printf '' > skills/empty/SKILL.md");
    await expect(run("cat skills/empty/SKILL.md")).resolves.toEqual({});
  });

  it("preserves Unicode and raw bytes across redirects and appends", async () => {
    const { files, run, output } = fixture();
    await run("printf '中文😀\\n' > USER.md; cat USER.md >> copy.txt; cat USER.md >> copy.txt; cat copy.txt");
    expect(files.readFile("/hermes/123/copy.txt").content).toBe("中文😀\n".repeat(2));
    expect(output.join("")).toBe("中文😀\n".repeat(2));
    await run("printf 'AP/DqQ==' | base64 -d > bytes.bin; cat bytes.bin >> joined.bin; cat joined.bin | base64");
    expect(files.readFileBuffer("/hermes/123/joined.bin").content).toEqual(new Uint8Array([0, 255, 195, 169]));
    expect(output.at(-1)).toBe("AP/DqQ==\n");
  });

  it("exposes stable file identities for safe shell copies and moves", async () => {
    const { files, run, output } = fixture();
    files.writeFile("/hermes/123/USER.md", "keep");
    const identity = files.stat("/hermes/123/USER.md").identity;
    expect(identity).toBeDefined();
    files.symlink("USER.md", "/hermes/123/alias");
    expect(files.stat("/hermes/123/alias").identity).toBe(identity);
    expect(files.lstat("/hermes/123/alias").identity).not.toBe(identity);
    await expect(run("cp USER.md alias")).rejects.toThrow("Command exited");
    expect(output.join("")).toContain("are the same file");
    await run("mv USER.md renamed.txt; printf old > other.txt; cp renamed.txt other.txt; mkdir -p tree/nested; cp other.txt tree/nested/file.txt; cp -r tree copied; mv copied moved");
    expect(files.stat("/hermes/123/renamed.txt").identity).toBe(identity);
    expect(files.stat("/hermes/123/other.txt").identity).not.toBe(identity);
    expect(files.readFile("/hermes/123/moved/nested/file.txt").content).toBe("keep");
  });

  it("rejects oversized shell writes without changing the previous contents or revision", async () => {
    const { files, run, revision } = fixture();
    const content = "x".repeat(MAX_FILE_BYTES);
    files.writeFile("/hermes/123/MEMORY.md", content);
    const previous = revision("MEMORY.md");
    await expect(run("printf x >> MEMORY.md")).rejects.toThrow("File is too large");
    expect(files.readFile("/hermes/123/MEMORY.md").content).toBe(content);
    expect(revision("MEMORY.md")).toBe(previous);
  });

  it("enforces the namespace file cap for shell writes and still allows updates", async () => {
    const { files, run } = fixture();
    for (let i = 0; i < 2000; i++) files.writeFile(`/hermes/123/skills/s${i}/SKILL.md`, "x");
    await expect(run("echo new > USER.md")).rejects.toThrow("Too many memory files");
    expect(files.exists("/hermes/123/USER.md")).toBe(false);
    await run("echo corrected > skills/s0/SKILL.md");
    expect(files.readFile("/hermes/123/skills/s0/SKILL.md").content).toBe("corrected\n");
  });

  it("does not inherit host secrets or run native programs", async () => {
    const { run, output } = fixture();
    process.env.DURABLE_BASH_TEST_SECRET = "not-for-the-shell";
    try {
      await run("echo \"$DURABLE_BASH_TEST_SECRET\"");
      expect(output.join("")).not.toContain("not-for-the-shell");
      for (const command of ["node -v", "python -V", "telegram_send 'text'"]) await expect(run(command)).rejects.toThrow("Command exited");
    } finally { delete process.env.DURABLE_BASH_TEST_SECRET; }
  });

  it("uses built-in curl with pipes and no deployment credentials", async () => {
    const mock = vi.fn(async (_url, options) => {
      expect(options).toMatchObject({ method: "GET", redirect: "manual" });
      const headers = new Headers(options.headers);
      for (const name of ["authorization", "cookie", "x-api-key"]) expect(headers.has(name)).toBe(false);
      return Response.json({ value: "公开 API" });
    }) as unknown as typeof fetch;
    const { run, output } = fixture(new WebAccess({}, mock));
    await run("curl -fsS https://8.8.8.8/data | jq -r .value; test -z \"$EXA_API_KEY$TELEGRAM_BOT_TOKEN$OPENROUTER_API_KEY\"");
    expect(output.join("")).toBe("公开 API\n");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("downloads binary bytes into the persistent filesystem without UTF-8 corruption", async () => {
    const mock = vi.fn(async () => new Response(new Uint8Array([0, 255, 195, 169]))) as unknown as typeof fetch;
    const { run, files, output } = fixture(new WebAccess({}, mock));
    await run("curl -fsS -o download.bin https://8.8.8.8/data; base64 download.bin");
    expect(files.readFileBuffer("/hermes/123/download.bin").content).toEqual(new Uint8Array([0, 255, 195, 169]));
    expect(output.join("")).toBe("AP/DqQ==\n");
  });

  it("retains curl's HTTP failure semantics", async () => {
    const mock = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const { run, output } = fixture(new WebAccess({}, mock));
    await run("curl -s https://8.8.8.8/missing");
    expect(output.join("")).toBe("not found");
    await expect(run("curl -fsS https://8.8.8.8/missing")).rejects.toThrow("Command exited");
  });

  it.each(["curl -X POST -d body https://8.8.8.8/data", "curl -H 'Host: internal' https://8.8.8.8/data", "curl https://127.0.0.1/private", "curl http://example.com"])("blocks unsafe curl requests before transport: %s", async command => {
    const mock = vi.fn() as unknown as typeof fetch;
    const { run } = fixture(new WebAccess({}, mock));
    await expect(run(command)).rejects.toThrow("Command exited");
    expect(mock).not.toHaveBeenCalled();
  });

  it("does not replace a downloaded file when an unadvertised response exceeds the HTTP limit", async () => {
    const cancel = vi.fn();
    const mock = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_WEB_BYTES)); controller.enqueue(new Uint8Array([1])); }, cancel }))) as unknown as typeof fetch;
    const { run, files, revision } = fixture(new WebAccess({}, mock));
    files.writeFile("/hermes/123/download.txt", "keep");
    const etag = revision("download.txt");
    await expect(run("curl -fsS -o download.txt https://8.8.8.8/large")).rejects.toThrow("Command exited");
    expect(cancel).toHaveBeenCalledOnce();
    expect(files.readFile("/hermes/123/download.txt").content).toBe("keep");
    expect(revision("download.txt")).toBe(etag);
  });

  it("aborts an in-flight curl on invocation cancellation and blocks subsequent writes", async () => {
    let requestSignal: AbortSignal | undefined;
    const mock = vi.fn(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      requestSignal = options.signal;
      requestSignal!.addEventListener("abort", () => reject(new Error("private transport detail")), { once: true });
    })) as unknown as typeof fetch;
    const { run, files } = fixture(new WebAccess({}, mock));
    const controller = new AbortController();
    const pending = run("curl -fsS https://8.8.8.8/slow; printf late > USER.md", 10, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(mock).toHaveBeenCalledOnce());
    controller.abort(new Error("cancelled"));
    await rejected;
    expect(requestSignal!.aborted).toBe(true);
    expect(files.exists("/hermes/123/USER.md")).toBe(false);
  });

  it("stops writes after timeout or invocation cancellation", async () => {
    const { files, run } = fixture();
    await expect(run("sleep 1; echo late > USER.md", 0.01)).rejects.toThrow();
    const controller = new AbortController();
    const pending = run("sleep 1; echo late > MEMORY.md", 1, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(files.exists("/hermes/123/USER.md")).toBe(false);
    expect(files.exists("/hermes/123/MEMORY.md")).toBe(false);
  });

  it("waits the full 120 seconds instead of clamping sleep to 60 seconds", async () => {
    const { files, run } = fixture();
    vi.useFakeTimers();
    try {
      const pending = run("sleep 120s; printf resumed > USER.md");
      await vi.advanceTimersByTimeAsync(119_999);
      expect(files.exists("/hermes/123/USER.md")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(files.readFile("/hermes/123/USER.md").content).toBe("resumed");
    } finally { vi.useRealTimers(); }
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
    for (const args of [{ command: "" }, { command: "x".repeat(32_001) }, ...[0, -1, 601].map(timeout => ({ command: "true", timeout }))]) {
      expect(() => validateToolArguments(tool, { type: "toolCall", id: "bash-test", name: "bash", arguments: args })).toThrow();
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
    files.writeFile("/hermes/123/MEMORY.md", content);
    expect(await store.promptContext()).toBe(`### MEMORY.md\n${content}`);
    await run("cat MEMORY.md > copy.txt; cat copy.txt");
    expect(files.readFile("/hermes/123/copy.txt").content).toBe(content);
    // just-bash decodes displayed text without the BOM, but redirects must preserve its bytes.
    expect(output.join("")).toBe(content.slice(1));
    files.writeFile("/hermes/123/USER.md", new Uint8Array([0xff]));
    await expect(store.promptContext()).rejects.toMatchObject({ status: 400 });
    expect(files.readFileBuffer("/hermes/123/USER.md").content).toEqual(new Uint8Array([0xff]));
  });

  it("does not auto-migrate on startup; manual migration preserves text, revisions and the source", async () => {
    const { storage, files, database, revision } = fixture();
    const insert = legacyTable(database);
    const content = "😀\n".repeat(50_000) + "x".repeat(MAX_FILE_BYTES - 250_000);
    const etag = crypto.randomUUID();
    insert.run("hermes/123/", "MEMORY.md", content, etag, MAX_FILE_BYTES);
    insert.run("hermes/123/", "skills/nested/demo/SKILL.md", "", crypto.randomUUID(), 0);
    insert.run("hermes/456/", "USER.md", "另一用户", crypto.randomUUID(), 12);
    new AgentFiles({ storage } as DurableObjectState, {});
    expect(files.exists("/hermes/123/MEMORY.md")).toBe(false);
    expect(migrateFiles(storage, files)).toEqual({ migrated: 3, verified: 3 });
    expect(files.readFile("/hermes/123/MEMORY.md").content).toBe(content);
    expect(revision("MEMORY.md")).toBe(etag);
    expect(revision("skills/nested/demo/SKILL.md")).not.toBeNull();
    expect(files.readFile("/hermes/456/USER.md").content).toBe("另一用户");
    expect(database.prepare("SELECT COUNT(*) AS count FROM hermes_text_files").get()).toMatchObject({ count: 3 });
    new AgentFiles({ storage } as DurableObjectState, {});
    expect(revision("MEMORY.md")).toBe(etag);
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
