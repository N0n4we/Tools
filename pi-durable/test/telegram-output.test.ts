import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantEntry, ToolResultEntry, type EntryRecord } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { TelegramOutput, type TextDelivery } from "../src/telegram-output.js";

const signal = new AbortController().signal;
const entry = (id: number, message: ReturnType<typeof fauxAssistantMessage>) => ({ id, conversationId: 1, kind: AssistantEntry.kind, model: [message] }) as EntryRecord;

function fixture() {
  const rows = new Map<string, TextDelivery>();
  const storage = { get: async (key: string) => structuredClone(rows.get(key)), put: async (key: string, value: TextDelivery) => { rows.set(key, structuredClone(value)); } } as unknown as DurableObjectStorage;
  const calls: { method: string; body: any }[] = [];
  let next = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ method: url.split("/").at(-1)!, body });
    return Response.json({ ok: true, result: { message_id: body.message_id ?? ++next } });
  }));
  const reopen = () => new TelegramOutput(storage, "test-bot", { id: "job", chatId: 123, replyTo: 2 });
  return { rows, calls, reopen, output: reopen() };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("durable Telegram presentation", () => {
  it("splits mixed content in source order and updates the tool card only from execution evidence", async () => {
    const { output, calls } = fixture();
    const call = fauxToolCall("bash", { command: "sleep 1" }, { id: "call-1" });
    await output.entry(entry(10, fauxAssistantMessage([fauxThinking("思考"), fauxText("正文"), call, fauxText("后文")], { stopReason: "toolUse" })), 0, signal);
    expect(calls.map(call => call.method)).toEqual(["sendMessage", "sendRichMessage", "sendRichMessage", "sendRichMessage"]);
    expect(calls[0]?.body.text).toBe("<blockquote expandable>思考</blockquote>");
    expect(calls[1]?.body.rich_message).toEqual({ markdown: "正文" });
    expect(calls[3]?.body.rich_message).toEqual({ markdown: "后文" });
    const status = (index: number) => calls[index]!.body.rich_message.blocks[0].summary[2].text;
    expect(status(2)).toBe("requested");
    await output.task({ kind: "pi.tool", input: { kind: "model", assistant: 10, callId: call.id }, state: { status: "running", checkpoint: { phase: "execute", arguments: { command: "validated command" }, replay: "unsafe" } } } as any, signal);
    expect(status(4)).toBe("running");
    const result = { id: 11, kind: ToolResultEntry.kind, model: [{ role: "toolResult", toolCallId: call.id, toolName: "bash", isError: false, content: [{ type: "text", text: "secret stdout must not be forwarded" }] }] } as EntryRecord;
    await output.entry(result, 10, signal);
    expect(status(5)).toBe("done");
    expect(calls.slice(4).every(call => call.method === "editMessageText" && call.body.message_id === 3)).toBe(true);
    expect(JSON.stringify(calls[5])).toContain("validated command");
    expect(JSON.stringify(calls)).not.toContain("secret stdout");
  });

  it("edits one bounded thinking disclosure, throttles progress and seals it across restart", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T00:00:00Z"));
    const { output, calls, reopen } = fixture();
    await output.partial(fauxAssistantMessage(fauxThinking("开始")), 0, 1, signal);
    await output.partial(fauxAssistantMessage(fauxThinking("开始思考")), 0, 2, signal);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    await output.partial(fauxAssistantMessage(fauxThinking("开始思考，更多进度")), 0, 3, signal);
    const final = entry(10, fauxAssistantMessage([fauxThinking("最终思考"), fauxText("最终正文")]));
    await output.entry(final, 0, signal);
    expect(calls.map(call => call.method)).toEqual(["sendMessage", "editMessageText", "editMessageText", "sendRichMessage"]);
    expect(calls[2]?.body).toMatchObject({ message_id: 1, text: "<blockquote expandable>最终思考</blockquote>" });
    const resumed = reopen();
    await resumed.entry(final, 0, signal);
    vi.advanceTimersByTime(2000);
    await resumed.partial(fauxAssistantMessage(fauxThinking("迟到的旧进度")), 0, 4, signal);
    expect(calls).toHaveLength(4);
    await resumed.entry(entry(12, fauxAssistantMessage(fauxThinking("最终思考"))), 10, signal);
    expect(calls.at(-1)?.method).toBe("sendMessage");
    expect(calls).toHaveLength(5);
  });

  it("never streams later thinking ahead of preceding public text", async () => {
    const { output, calls } = fixture();
    const message = fauxAssistantMessage([fauxText("先说正文"), fauxThinking("后面的思考")]);
    await output.partial(message, 0, 1, signal);
    expect(calls).toHaveLength(0);
    await output.entry(entry(10, message), 0, signal);
    expect(calls.map(call => call.method)).toEqual(["sendRichMessage", "sendMessage"]);
  });

  it("skips empty/redacted reasoning and opaque signatures without inventing thinking", async () => {
    const { output, calls } = fixture();
    await output.entry(entry(10, fauxAssistantMessage([{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque-secret" }])), 0, signal);
    expect(calls).toHaveLength(0);
    await output.entry(entry(12, fauxAssistantMessage([])), 10, signal);
    expect(calls[0]?.body.rich_message.markdown).toBe("（空回复）");
    expect(JSON.stringify(calls)).not.toContain("opaque-secret");
  });

  it.each(["error", "aborted"] as const)("leaves %s failures for the job error delivery", async stopReason => {
    const { output, calls } = fixture();
    await output.entry(entry(10, fauxAssistantMessage("部分正文", { stopReason })), 0, signal);
    expect(calls).toHaveLength(0);
  });

  it("keeps length-limited partial replies with an explicit status", async () => {
    const { output, calls } = fixture();
    await output.entry(entry(10, fauxAssistantMessage("部分正文", { stopReason: "length" })), 0, signal);
    expect(calls.map(call => call.body.rich_message.markdown)).toEqual(["（回复状态：length）", "部分正文"]);
  });

  it("does not downgrade or duplicate a completed tool card when history is replayed", async () => {
    const { output, reopen, calls } = fixture();
    const call = fauxToolCall("bash", { command: "exit 7" }, { id: "failed-call" });
    const assistant = entry(10, fauxAssistantMessage(call, { stopReason: "toolUse" }));
    const task = { kind: "pi.tool", input: { kind: "model", assistant: 10, callId: call.id }, state: { status: "terminal", outcome: { status: "faulted", error: { message: "private runtime error" } } } } as any;
    await output.entry(assistant, 0, signal);
    await output.task(task, signal);
    const resumed = reopen();
    await resumed.entry(assistant, 0, signal);
    await resumed.task(task, signal);
    expect(calls.map(call => call.method)).toEqual(["sendRichMessage", "editMessageText"]);
    expect(calls.at(-1)?.body.rich_message.blocks[0].summary[2].text).toBe("failed");
    expect(JSON.stringify(calls)).not.toContain("private runtime error");
  });

  it("keeps legacy plain-text receipts and pending parts readable without a second presentation", async () => {
    const { output, rows, calls, reopen } = fixture();
    rows.set("assistant:10", { status: "ready", parts: ["旧格式正文"], nextPart: 0, deliveryAttempts: 0 });
    const assistant = entry(10, fauxAssistantMessage("旧格式正文"));
    await output.entry(assistant, 0, signal);
    await reopen().entry(assistant, 0, signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "sendMessage", body: { text: "旧格式正文" } });
  });

  it("correlates reused provider call IDs to their assistant entries during recovery", async () => {
    const { output, reopen, calls } = fixture();
    const first = entry(10, fauxAssistantMessage(fauxToolCall("bash", { command: "first" }, { id: "reused" }), { stopReason: "toolUse" }));
    const second = entry(20, fauxAssistantMessage(fauxToolCall("bash", { command: "second" }, { id: "reused" }), { stopReason: "toolUse" }));
    await output.entry(first, 0, signal);
    await output.entry(second, 10, signal);
    const resumed = reopen();
    await resumed.entry(first, 0, signal);
    await resumed.entry(second, 10, signal);
    await resumed.task({ kind: "pi.tool", input: { kind: "model", assistant: 10, callId: "reused" }, state: { status: "terminal", outcome: { status: "faulted" } } } as any, signal);
    await resumed.entry({ id: 21, kind: ToolResultEntry.kind, model: [{ role: "toolResult", toolCallId: "reused", toolName: "bash", isError: false, content: [] }] } as EntryRecord, 20, signal);
    expect(calls.slice(2).map(call => [call.body.message_id, call.body.rich_message.blocks[0].summary[2].text])).toEqual([[1, "failed"], [2, "done"]]);
  });

  it("does not send again after an edit intent lost its receipt", async () => {
    const { output, rows, calls, reopen } = fixture();
    const message = fauxAssistantMessage(fauxThinking("先思考"));
    await output.partial(message, 0, 1, signal);
    const key = [...rows.keys()].find(key => key.startsWith("thinking:"))!;
    rows.set(key, { ...rows.get(key)!, status: "sending" });
    await expect(reopen().entry(entry(10, message), 0, signal)).rejects.toMatchObject({ uncertain: true });
    expect(calls).toHaveLength(1);
    expect(rows.get(key)).toMatchObject({ status: "failed", error: "telegram_delivery_uncertain" });
  });
});
