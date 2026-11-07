import { afterEach, describe, expect, it, vi } from "vitest";
import { openRouterModels } from "../src/pi/models.js";
import type { Env } from "../src/env.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe.each(["complete", "completeSimple"] as const)("OpenRouter routing (%s)", mode => {
  it.each(["default", "return", "mutate"])("leaves provider selection to OpenRouter or the caller's payload hook (%s)", async hookMode => {
    const payloads: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      payloads.push(JSON.parse(init.body as string));
      return new Response('data: {"id":"routing-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }));
    const runtime = openRouterModels({ OPENROUTER_API_KEY: "synthetic-key" } as Env);
    const selection = { only: ["google-vertex"], order: ["google-vertex"], allow_fallbacks: true };
    const answer = await runtime.models[mode](runtime.models.getModel(runtime.model.provider, runtime.model.modelId), {
      messages: [{ role: "user", content: "synthetic input", timestamp: 1 }],
    }, {
      onPayload(payload) {
        const request = payload as any;
        expect(request).not.toHaveProperty("provider");
        if (hookMode === "mutate") request.provider = selection;
        else if (hookMode === "return") return { ...request, provider: selection };
      },
    });
    expect(answer.stopReason).toBe("stop");
    expect(payloads).toHaveLength(1);
    expect(payloads[0].stream).toBe(true);
    if (hookMode === "default") expect(payloads[0]).not.toHaveProperty("provider");
    else expect(payloads[0].provider).toEqual(selection);
  });
});
