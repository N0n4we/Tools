import worker from "../src/index.js";
import { AgentBackend, type Job } from "../src/agent.js";
import { errorResponse } from "../src/http.js";
import { validatePath } from "../src/memory/store.js";
import { openAgentStorage } from "../src/pi/storage.js";
import type { TextDelivery } from "../src/telegram-output.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, ProviderDoc, SystemEntry, UserEntry, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
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
          if (url.searchParams.has("expired")) job.createdAt = Date.now() - 7 * 60 * 60_000;
          await this.ctx.storage.put({ [`job:${id}`]: job, [`pending:${String(job.sequence).padStart(16, "0")}`]: id });
        }
        return Response.json(job ? { ...job, speech: await this.ctx.storage.get(`speech:${id}`) } : null);
      }
      if (url.pathname === "/test/deliveries") {
        const deliveries = new Map([...await this.ctx.storage.list<TextDelivery>({ prefix: "assistant:" }), ...await this.ctx.storage.list<TextDelivery>({ prefix: "thinking:" })]);
        if (request.method === "PUT") {
          // Restore the intent checkpoint after Telegram accepted a part but before its receipt was saved.
          for (const [key, delivery] of deliveries) {
            if (delivery.presentation === "blocks") {
              delivery.status = "running";
              await this.ctx.storage.put(key, delivery);
              continue;
            }
            delivery.status = "sending";
            delivery.nextPart = 0;
            delete delivery.sentIds;
            await this.ctx.storage.put(key, delivery);
          }
        }
        return Response.json(Object.fromEntries(deliveries));
      }
      if (url.pathname === "/test/context") {
        const { models, model } = this.modelRuntime();
        const harness = await Harness.open(await openAgentStorage(this.ctx.storage), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
        try {
          const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model } });
          if (request.method === "PATCH") {
            const sections = await request.json() as Record<string, string>;
            await root.commit(tx => tx.appendEntry(SystemEntry, root.id, { model: [{ role: "system", content: "", sections, timestamp: Date.now() }] }), BACKGROUND_CONTEXT);
          }
          if (request.method === "PUT" || request.method === "POST") {
            const messages = await request.json() as string[];
            const timestamp = Number(url.searchParams.get("timestamp") ?? Date.now());
            await root.commit(async tx => {
              for (const content of messages) {
                if (request.method === "POST") await tx.appendEntry(AssistantEntry, root.id, { model: [fauxAssistantMessage(content, { timestamp })] });
                else await tx.appendEntry(UserEntry, root.id, { model: [{ role: "user", content, timestamp }] });
              }
            }, BACKGROUND_CONTEXT);
          }
          return Response.json({ context: await root.context(BACKGROUND_CONTEXT), entries: (await root.entries({}, 1000, undefined, BACKGROUND_CONTEXT)).items, provider: await harness.snapshot(ProviderDoc, root.id, BACKGROUND_CONTEXT) });
        } finally { await harness.close(BACKGROUND_CONTEXT); }
      }
      if (url.pathname === "/test/session") {
        const sql = this.ctx.storage.sql;
        const trigger = url.searchParams.has("retry") ? "test_retry_failure" : "test_discard_failure";
        if (request.method === "PUT") sql.exec(`CREATE TRIGGER ${trigger} BEFORE ${url.searchParams.has("retry") ? "UPDATE" : "DELETE"} ON entries BEGIN SELECT RAISE(ABORT, 'simulated discard failure'); END`);
        if (request.method === "DELETE") sql.exec(`DROP TRIGGER ${trigger}`);
        return Response.json(Object.fromEntries(["record_ids", "conversations", "entries", "tasks", "submissions", "documents", "document_revisions"].map(name => [name, sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${name}`).toArray()[0]!.count])));
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
        const path = validatePath(url.searchParams.get("path")!);
        const absolute = `/hermes/123/${path}`;
        if (request.method === "PUT") {
          const body = await request.json() as { content: string };
          this.writeFile(absolute, body.content);
        }
        const etag = this.ctx.storage.sql.exec<{ etag: string }>("SELECT etag FROM files WHERE path = ?", absolute).toArray()[0]?.etag ?? null;
        return Response.json({ path, content: etag === null ? "" : this.readFile(absolute).content, etag });
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
      for (const message of context.messages) {
        if (message.role === "system") continue;
        const time = new Date(message.timestamp + 8 * 60 * 60_000).toISOString().slice(0, 19).replace("T", " ");
        const prefix = `[${time}]\n`;
        const first = typeof message.content === "string" ? message.content.slice(0, prefix.length) : message.content[0]?.type === "text" ? message.content[0].text : undefined;
        if (first !== prefix) throw new Error(`Missing message timestamp for ${message.role}: ${first}`);
      }
      const tools = getCurrentTools(context.messages).map(tool => tool.name).sort();
      const expected = input.includes("定时文字叫醒") ? ["bash", "fetch_content", "web_search"] : ["bash", "fetch_content", "telegram_speak", "web_search"];
      if (JSON.stringify(tools) !== JSON.stringify(expected)) throw new Error(`Unexpected tools: ${tools.join(", ")}`);
      const sections = getCurrentSystemMessage(context.messages)?.sections;
      if (input.includes("role-format")) {
        if (!sections?.conversation?.includes("测试角色小岚") || !sections.conversation.includes("动作必须用（）包裹")) throw new Error("Role preferences were not loaded before the first reply");
        return fauxAssistantMessage(input.includes("second") ? "[2026-10-25 12-03-34]（微笑）第二轮。" : "（轻轻点头）第一轮。");
      }
      if (input.includes("定时文字叫醒")) {
        if (!last || Math.abs(Date.now() - last.timestamp) > 120_000) throw new Error("Latest message time is stale");
        if (getCurrentTools(context.messages).some(tool => tool.name === "telegram_speak")) throw new Error("Wakeup still offers the speech tool");
      }
      if (input.includes("我醒了")) return fauxAssistantMessage("已停止提醒。");
      if (input.includes("intermediate-text")) {
        if (last?.role === "toolResult" && input.includes("then-fail")) return fauxAssistantMessage("失败的部分正文。", { stopReason: "error", errorMessage: "fixture failure" });
        if (last?.role === "toolResult") return fauxAssistantMessage([fauxThinking("最终思考内容。"), fauxText("最终正文。")]);
        return fauxAssistantMessage([
          fauxThinking("中途思考内容。"), fauxText("中途正文一。"), fauxText("中途正文二。"),
          fauxToolCall("bash", { command: `printf '工具输出不能发送'; printf '工具错误输出不能发送' >&2${input.includes("then-fail") ? "" : "; sleep 1"}` }),
        ], { stopReason: "toolUse" });
      }
      if (input.includes("long-text")) return fauxAssistantMessage("中😀".repeat(8000));
      if (input.includes("length-text")) return fauxAssistantMessage("[2026-10-25", { stopReason: "length" });
      if (input.includes("thinking-only")) return fauxAssistantMessage(fauxThinking("只有思考内容。"));
      if (input.includes("empty-assistant")) return fauxAssistantMessage([]);
      if (input.includes("aborted-text")) return fauxAssistantMessage("中断的部分正文。", { stopReason: "aborted" });
      if (input.includes("failed-text")) return fauxAssistantMessage("失败的部分正文。", { stopReason: "error", errorMessage: "fixture failure" });
      if (last?.role === "toolResult") {
        if (input.includes("定时文字叫醒") && last.isError && JSON.stringify(last.content).includes("interrupted")) return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1" }), { stopReason: "toolUse" });
        if (last.toolName === "telegram_speak") {
          if (last.isError) return fauxAssistantMessage("语音发送未确认，请检查 Telegram，不会自动重试。");
          const result = JSON.parse(last.content.slice(1).flatMap(block => block.type === "text" ? [block.text] : []).join(""));
          if (input.includes("speak-twice") && result.duplicate !== true) return fauxAssistantMessage(fauxToolCall("telegram_speak", { text: "你好，这是本地语音测试。" }), { stopReason: "toolUse" });
          return fauxAssistantMessage("语音已发送。");
        }
        if (last.isError) throw new Error("A local integration tool failed");
        if (last.toolName === "bash") {
          const output = JSON.stringify(last.content);
          if (input.includes("speak")) {
            return fauxAssistantMessage(fauxToolCall("telegram_speak", { text: "你好，这是本地语音测试。" }), { stopReason: "toolUse" });
          }
          if ((input.includes("remember") || input.includes("bash-files")) && !output.includes("测试用户喜欢简洁回答")) throw new Error("Bash did not read the shared memory file");
          if ((input.includes("persist-skill") || input.includes("bash-files")) && !output.includes("持久化技能参考")) throw new Error("Bash did not read the Skill reference");
          if (input.includes("curl-read") && !output.includes("公开网页正文")) throw new Error("Built-in curl did not download the public page");
          if (input.includes("remember") && !sections?.conversation?.includes("测试用户喜欢简洁回答")) throw new Error("Memory prompt context was not refreshed");
        }
        if (last.toolName === "fetch_content" && !JSON.stringify(last.content).includes("公开网页正文")) throw new Error("Web fixture was not actually read");
        if (last.toolName === "web_search") {
          const results = last.content.slice(1).flatMap(block => block.type === "text" ? [block.text] : []).join("");
          if (!results.includes("Exa 搜索摘要") || !results.includes("https://example.com/story") || results.includes("127.0.0.1")) throw new Error("Exa results were not normalized or filtered");
          if (JSON.stringify(context.messages).includes("test-exa-key")) throw new Error("Search Secret reached the model context");
        }
        return fauxAssistantMessage("本地工具执行完成。");
      }
      if (input.includes("speak")) return fauxAssistantMessage(fauxToolCall("bash", { command: "cat skills/telegram-speech/SKILL.md" }), { stopReason: "toolUse" });
      if (input.includes("remember")) return fauxAssistantMessage(fauxToolCall("bash", { command: "printf '测试用户喜欢简洁回答\\n' >> MEMORY.md; cat MEMORY.md" }), { stopReason: "toolUse" });
      if (input.includes("exa-search")) return fauxAssistantMessage(fauxToolCall("web_search", { query: "Cloudflare Workers", numResults: 3 }), { stopReason: "toolUse" });
      if (input.includes("curl-read")) return fauxAssistantMessage(fauxToolCall("bash", { command: "mkdir -p skills/curl; curl -fsS -o skills/curl/page.txt https://example.com/story; cat skills/curl/page.txt; test -z \"$OPENROUTER_API_KEY$TELEGRAM_BOT_TOKEN$EXA_API_KEY\"" }), { stopReason: "toolUse" });
      if (input.includes("网页")) return fauxAssistantMessage(fauxToolCall("fetch_content", { url: "https://example.com/story" }), { stopReason: "toolUse" });
      if (input.includes("persist-skill")) return fauxAssistantMessage(fauxToolCall("bash", { command: "mkdir -p skills/test/nested/references; printf '持久化技能参考' > skills/test/nested/references/check.md; cat skills/test/nested/references/check.md" }), { stopReason: "toolUse" });
      if (input.includes("bash-files")) return fauxAssistantMessage(fauxToolCall("bash", { command: "cat MEMORY.md; mkdir -p skills/bash/demo; printf '持久化技能参考' > skills/bash/demo/SKILL.md; cat skills/bash/demo/SKILL.md; printf 'bash 追加记忆\\n' >> MEMORY.md; test -z \"$OPENROUTER_API_KEY$TELEGRAM_BOT_TOKEN$EXA_API_KEY\"" }), { stopReason: "toolUse" });
      if (input.includes("定时文字叫醒")) return fauxAssistantMessage([fauxText("起床啦，开始新的一天。"), fauxToolCall("bash", { command: "sleep 1" })], { stopReason: "toolUse" });
      return fauxAssistantMessage("本地测试回答。");
    }));
    const models = createModels();
    models.setProvider(faux.provider);
    return { models, model: { provider: "faux", modelId: "faux-1" } };
  }
}

export class StreamingAgent extends ProbeAgent {
  protected override modelRuntime() {
    const faux = fauxProvider({ tokensPerSecond: 32, tokenSize: { min: 8, max: 8 } });
    faux.setResponses([fauxAssistantMessage([fauxThinking("流式思考。".repeat(96)), fauxText("流式完成。")])]);
    const models = createModels();
    models.setProvider(faux.provider);
    return { models, model: { provider: "faux", modelId: "faux-1" } };
  }
}

export class FailSecondAgent extends TestAgent {
  private modelCalls = 0;
  protected override modelRuntime() {
    if (++this.modelCalls === 2) throw new Error("simulated model configuration failure");
    return super.modelRuntime();
  }
}

export { AgentBackend };
export default worker;
