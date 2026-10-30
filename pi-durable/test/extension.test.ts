import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { createSession, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { timestampEntry } from "../src/pi/timestamps.js";

async function format(messages: Message[]) {
  let previous: number | undefined;
  return messages.flatMap(message => {
    const entries = timestampEntry({ kind: `test.${message.role}`, model: [message] }, previous);
    if (message.role !== "system") previous = message.timestamp;
    return entries.flatMap(entry => entry.model ?? []);
  });
}

describe("persisted time metadata", () => {
  it("stages date entries with their message atomically and publishes the persisted record", async () => {
    const storage = Object.assign(new MemoryStorage(), {
      prepareEntry: ((_conversationId, value, staged) => {
        const previous = staged.flatMap(entry => entry.model ?? []).reverse().find(message => message.role !== "system");
        return timestampEntry(value, previous?.timestamp);
      }) satisfies NonNullable<Storage["prepareEntry"]>,
    });
    const session = createSession(storage);
    try {
      const conversation = await session.commit(tx => tx.createConversation({ ownership: { kind: "ownerless" } }), BACKGROUND_CONTEXT);
      const append = async (fail: boolean) => session.commit(async tx => {
        await tx.appendEntry(conversation.id, { kind: "pi.user", model: [{ role: "user", content: "first", timestamp: Date.parse("2026-12-31T15:59:59Z") }] });
        const record = await tx.appendEntry(conversation.id, { kind: "pi.assistant", model: [fauxAssistantMessage("second", { timestamp: Date.parse("2026-12-31T16:00:00Z") })] });
        if (fail) throw new Error("rollback");
        return record;
      }, BACKGROUND_CONTEXT);
      await expect(append(true)).rejects.toThrow("rollback");
      expect((await storage.scanEntries({ conversationId: conversation.id }, 100, undefined, BACKGROUND_CONTEXT)).items).toEqual([]);
      const record = await append(false);
      const entries = (await storage.scanEntries({ conversationId: conversation.id, order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
      expect(entries.map(entry => entry.kind)).toEqual(["pi.user", "telegram.date", "pi.assistant"]);
      expect(entries[1]!.model).toMatchObject([{ role: "user", content: "[2027-01-01 Friday]" }]);
      expect(entries[2]).toEqual(record);
      expect(record.model?.[0]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "[00:00:00]\n" }, { type: "text", text: "second" }] });
    } finally { await session.close(BACKGROUND_CONTEXT); }
  });

  it("inserts the new Shanghai date and English weekday only at date changes", async () => {
    const messages: Message[] = [
      { role: "user", content: "before midnight", timestamp: Date.parse("2026-12-31T15:59:59Z") },
      fauxAssistantMessage("after midnight", { timestamp: Date.parse("2026-12-31T16:00:00Z") }),
      { role: "user", content: [{ type: "text", text: "same day" }], timestamp: Date.parse("2026-12-31T16:00:01Z") },
      { role: "toolResult", toolCallId: "call", toolName: "bash", isError: false, content: [{ type: "text", text: "result" }], timestamp: Date.parse("2027-01-02T16:00:00Z") },
    ];
    const original = structuredClone(messages);
    const formatted = await format(messages);
    expect(formatted).toHaveLength(6);
    expect(formatted[0]).toMatchObject({ content: "[23:59:59]\nbefore midnight" });
    expect(formatted[1]).toEqual({ role: "user", content: "[2027-01-01 Friday]", timestamp: messages[1]!.timestamp });
    expect(formatted[2]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "[00:00:00]\n" }, { type: "text", text: "after midnight" }] });
    expect(formatted[3]).toMatchObject({ content: [{ type: "text", text: "[00:00:01]\n" }, { type: "text", text: "same day" }] });
    expect(formatted[4]).toMatchObject({ role: "user", content: "[2027-01-03 Sunday]" });
    expect(formatted[5]).toMatchObject({ role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "[00:00:00]\n" }, { type: "text", text: "result" }] });
    expect(messages).toEqual(original);
    expect(await format(messages)).toEqual(formatted);
  });

  it("leaves system messages unchanged and ignores them when detecting date changes", async () => {
    const system: Message = { role: "system", content: "instructions", timestamp: 0 };
    const messages: Message[] = [
      system,
      { role: "user", content: "first", timestamp: Date.parse("2028-02-28T15:59:59Z") },
      system,
      { role: "user", content: "leap day", timestamp: Date.parse("2028-02-28T16:00:00Z") },
    ];
    const formatted = await format(messages);
    expect(formatted[0]).toBe(system);
    expect(formatted[2]).toBe(system);
    expect(formatted[3]).toMatchObject({ content: "[2028-02-29 Tuesday]" });
    expect(await format([])).toEqual([]);
    expect(await format([system])).toEqual([system]);
  });
});
