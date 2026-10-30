import type { Message } from "@earendil-works/pi-ai";
import type { EntryDraft } from "@earendil-works/pi-durable";

const localTime = (timestamp: number) => new Date(timestamp).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false });

// Called once when an entry is staged, not when history is read or sent to a model.
export function timestampEntry(value: EntryDraft, previousTimestamp?: number): EntryDraft[] {
  const entries: EntryDraft[] = [];
  let model: Message[] = [];
  let previousDate = previousTimestamp === undefined ? undefined : localTime(previousTimestamp).slice(0, 10);
  for (const message of value.model ?? []) {
    if (message.role === "system") {
      model.push(message);
      continue;
    }
    const local = localTime(message.timestamp);
    const day = local.slice(0, 10);
    if (previousDate !== undefined && previousDate !== day) {
      const weekday = new Date(message.timestamp).toLocaleDateString("en-US", { timeZone: "Asia/Shanghai", weekday: "long" });
      // Built-in Pi entries contain one model message; keep its role at model[0].
      if (model.length) {
        entries.push({ ...value, model });
        model = [];
      }
      entries.push({ kind: "telegram.date", model: [{ role: "user", content: `[${day} ${weekday}]`, timestamp: message.timestamp }] });
    }
    previousDate = day;
    const prefix = { type: "text" as const, text: `[${local.slice(11)}]\n` };
    if (message.role === "user") model.push({ ...message, content: typeof message.content === "string" ? prefix.text + message.content : [prefix, ...message.content] });
    else if (message.role === "assistant") model.push({ ...message, content: [prefix, ...message.content] });
    else model.push({ ...message, content: [prefix, ...message.content] });
  }
  entries.push(value.model === undefined ? value : { ...value, model });
  return entries;
}
