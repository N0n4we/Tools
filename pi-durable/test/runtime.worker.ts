import worker from "../src/index.js";
import { AgentBackend, type Job } from "../src/agent.js";
import { errorResponse } from "../src/http.js";
import { MemoryStore } from "../src/memory/store.js";
import { openAgentStorage } from "../src/pi/storage.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, UserEntry, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

// Probes exist only in the test Worker and are called through the namespace stub.
export class ProbeAgent extends AgentBackend {
  override async fetch(request: Request) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/test/jobs/")) {
        const id = url.pathname.slice("/test/jobs/".length);
        const job = await this.ctx.storage.get<Job>(`job:${id}`);
        if (job && request.method === "PUT") {
          // Restore the checkpoint before Telegram delivery to exercise restart recovery.
          job.status = "running";
          job.nextPart = 0;
          delete job.parts;
          delete job.sentIds;
          await this.ctx.storage.put({ [`job:${id}`]: job, [`pending:${String(job.sequence).padStart(16, "0")}`]: id });
        }
        return Response.json(job ? { ...job, speech: await this.ctx.storage.get(`speech:${id}`) } : null);
      }
      if (url.pathname === "/test/wakeup") return Response.json(await this.ctx.storage.get("wakeup") ?? { active: false });
      if (url.pathname === "/test/context") {
        const { models, model } = this.modelRuntime();
        const harness = await Harness.open(await openAgentStorage(this.ctx.storage), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
        try {
          const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model } });
          if (request.method === "PUT") {
            const messages = await request.json() as string[];
            await root.commit(async tx => {
              for (const content of messages) await tx.appendEntry(UserEntry, root.id, { model: [{ role: "user", content, timestamp: Date.now() }] });
            }, BACKGROUND_CONTEXT);
          }
          return Response.json({ context: await root.context(BACKGROUND_CONTEXT), entries: (await root.entries({}, 1000, undefined, BACKGROUND_CONTEXT)).items });
        } finally { await harness.close(BACKGROUND_CONTEXT); }
      }
      if (url.pathname === "/test/legacy") {
        const sql = this.ctx.storage.sql;
        if (request.method === "PUT") {
          const files = await request.json() as { path: string; content: string; etag: string }[];
          sql.exec("CREATE TABLE hermes_text_files (namespace TEXT, path TEXT, content TEXT, etag TEXT, bytes INTEGER, PRIMARY KEY(namespace, path))");
          for (const file of files) sql.exec("INSERT INTO hermes_text_files VALUES (?, ?, ?, ?, ?)", "hermes/123/", file.path, file.content, file.etag, new TextEncoder().encode(file.content).byteLength);
        }
        return Response.json({ present: sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'hermes_text_files'").toArray().length > 0 });
      }
      if (url.pathname === "/test/memory/file") {
        const store = new MemoryStore(this.ctx.storage, "hermes/123/", this);
        const path = url.searchParams.get("path")!;
        if (request.method === "GET") return Response.json(await store.read(path));
        const body = await request.json() as { content: string; etag?: string | null };
        return Response.json(await store.write(path, body.content, body.etag));
      }
      return super.fetch(request);
    } catch (error) { return errorResponse(error); }
  }
}

// Production always uses the real OpenRouter provider and Workers Secret bindings.
export class TestAgent extends ProbeAgent {
  protected override modelRuntime() {
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 12 }, () => (context) => {
      const last = [...context.messages].reverse().find((message) => message.role !== "system");
      const user = [...context.messages].reverse().find((message) => message.role === "user");
      const input = user?.role === "user" ? (typeof user.content === "string" ? user.content : user.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")) : "";
      if (input.startsWith("<conversation>\n")) {
        if (input.includes("compaction-failure")) return fauxAssistantMessage("incomplete", { stopReason: "length" });
        return fauxAssistantMessage("测试压缩摘要：保留重要事实和未完成任务。");
      }
      if (input.includes("这是唤醒")) {
        if (getCurrentTools(context.messages).some(tool => tool.name === "telegram_speak")) throw new Error("Wakeup still offers the speech tool");
        if (getCurrentSystemMessage(context.messages)?.sections?.telegram_speech !== undefined) throw new Error("Wakeup still includes the speech prompt section");
      }
      if (last?.role === "toolResult") {
        // Deliberately challenge the production guard with an internal prompt.
        if (last.toolName === "wakeup_confirm" && last.isError && JSON.stringify(last.content).includes("No new user reply")) return fauxAssistantMessage("起床啦，醒了告诉我。");
        if (last.toolName === "telegram_speak") {
          if (last.isError) return fauxAssistantMessage("语音发送未确认，请检查 Telegram，不会自动重试。");
          const result = JSON.parse(last.content.flatMap(block => block.type === "text" ? [block.text] : []).join(""));
          if (input.includes("speak-twice") && result.duplicate !== true) return fauxAssistantMessage(fauxToolCall("telegram_speak", { text: "你好，这是本地语音测试。" }), { stopReason: "toolUse" });
          return fauxAssistantMessage("语音已发送。");
        }
        if (last.isError) throw new Error("A local integration tool failed");
        if (last.toolName === "bash") {
          if (!JSON.stringify(last.content).includes("测试用户喜欢简洁回答")) throw new Error("Bash did not read the shared memory file");
          return fauxAssistantMessage(fauxToolCall("skill_read", { slug: "bash/demo" }), { stopReason: "toolUse" });
        }
        if (last.toolName === "web_fetch" && !JSON.stringify(last.content).includes("公开网页正文")) throw new Error("Web fixture was not actually read");
        if (last.toolName === "skill_save") return fauxAssistantMessage(fauxToolCall("skill_read", { slug: "test/nested", file: "references/check.md" }), { stopReason: "toolUse" });
        if (last.toolName === "skill_read" && !JSON.stringify(last.content).includes("持久化技能参考")) throw new Error("Skill reference did not persist");
        return fauxAssistantMessage("本地工具执行完成。");
      }
      if (input.includes("speak")) return fauxAssistantMessage(fauxToolCall("telegram_speak", { text: "你好，这是本地语音测试。" }), { stopReason: "toolUse" });
      if (input.includes("remember")) return fauxAssistantMessage(fauxToolCall("memory_append", { path: "MEMORY.md", content: "测试用户喜欢简洁回答" }), { stopReason: "toolUse" });
      if (input.includes("网页")) return fauxAssistantMessage(fauxToolCall("web_fetch", { url: "https://example.com/story" }), { stopReason: "toolUse" });
      if (input.includes("我醒了")) return fauxAssistantMessage(fauxToolCall("wakeup_confirm", { reason: "用户明确表示已清醒" }), { stopReason: "toolUse" });
      if (input.includes("persist-skill")) return fauxAssistantMessage(fauxToolCall("skill_save", { slug: "test/nested", file: "references/check.md", content: "持久化技能参考", etag: null }), { stopReason: "toolUse" });
      if (input.includes("bash-files")) return fauxAssistantMessage(fauxToolCall("bash", { command: "cat MEMORY.md; printf '持久化技能参考' > skills/bash/demo/SKILL.md; printf 'bash 追加记忆\\n' >> MEMORY.md; test -z \"$OPENROUTER_API_KEY$TELEGRAM_BOT_TOKEN\"" }), { stopReason: "toolUse" });
      if (input.includes("这是唤醒")) return fauxAssistantMessage(fauxToolCall("wakeup_confirm", { reason: "内部提醒不应能够自行确认" }), { stopReason: "toolUse" });
      return fauxAssistantMessage("本地测试回答。");
    }));
    const models = createModels();
    models.setProvider(faux.provider);
    return { models, model: { provider: "faux", modelId: "faux-1" } };
  }
}

export { AgentBackend };
export default worker;
