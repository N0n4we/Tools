import worker from "../src/index.js";
import { AgentBackend } from "../src/agent.js";
import { MemoryStore } from "../src/memory/store.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

// This provider substitution exists only in the test Worker. Production always
// uses the real OpenRouter provider and Workers Secret bindings.
export class TestAgent extends AgentBackend {
  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/test/memory-probe") {
      // Only this test subclass exposes the probe, via the namespace stub.
      // Return metadata only, never the user's memory text or search snippets.
      const store = new MemoryStore(this.ctx.storage, "hermes/123/");
      return Response.json({ skillCount: (await store.skills()).length, matchedPaths: (await store.search(url.searchParams.get("query") ?? "")).map((hit) => hit.path) });
    }
    return super.fetch(request);
  }

  protected override modelRuntime() {
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 12 }, () => (context) => {
      const last = [...context.messages].reverse().find((message) => message.role !== "system");
      const user = [...context.messages].reverse().find((message) => message.role === "user");
      const input = user?.role === "user" ? (typeof user.content === "string" ? user.content : user.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")) : "";
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
