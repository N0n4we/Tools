import { defineExtension, section } from "@earendil-works/pi-durable";
import type { MemoryStore } from "./store.js";

export function toolText(value: unknown) {
  return { output: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function memoryExtension(store: MemoryStore) {
  return defineExtension({
    name: "hermes-files",
    sections: [section("hermes_memory", async () => {
      const text = await store.promptContext();
      return text || undefined;
    })],
  });
}
