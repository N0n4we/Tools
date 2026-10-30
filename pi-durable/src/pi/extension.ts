import { defineExtension, section } from "@earendil-works/pi-durable";
import type { MemoryStore } from "../memory/store.js";

export function agentExtension(store: MemoryStore) {
  return defineExtension({
    name: "telegram-agent",
    sections: [section("conversation", async () => `${await store.promptContext()}`)],
  });
}
