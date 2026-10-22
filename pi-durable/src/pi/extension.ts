import { defineExtension, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import type { MemoryStore } from "../memory/store.js";

export function agentExtension(store: MemoryStore) {
  return defineExtension({
    name: "telegram-agent",
    sections: [section("conversation", async () => `${await store.promptContext()}`)],
    hooks: [hook(GenerationTask, {
      beforeRequest: ({ messages }) => ({ messages: messages.map(message => {
        if (message.role === "system") return message;
        const time = new Date(message.timestamp).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false });
        const prefix = { type: "text" as const, text: `[${time}]\n` };
        if (message.role === "user") return { ...message, content: typeof message.content === "string" ? prefix.text + message.content : [prefix, ...message.content] };
        if (message.role === "assistant") return { ...message, content: [prefix, ...message.content] };
        return { ...message, content: [prefix, ...message.content] };
      }) }),
    })],
  });
}
