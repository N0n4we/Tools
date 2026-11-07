import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openRouterModels } from "../src/pi/models.js";
import type { Env } from "../src/env.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("OpenRouter transport cancellation", () => {
  it("closes the actual HTTP streaming connection when generation is aborted", async () => {
    let connected!: () => void;
    let disconnected!: () => void;
    const open = new Promise<void>(resolve => { connected = resolve; });
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"synthetic-stream","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"test"},"finish_reason":null}]}\n\n');
      response.once("close", disconnected);
      connected();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local test address");
    const nativeFetch = globalThis.fetch.bind(globalThis);
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (url: string, options: RequestInit) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
      requestSignal = options.signal ?? undefined;
      return nativeFetch(`http://127.0.0.1:${address.port}/`, options);
    });
    try {
      const runtime = openRouterModels({ OPENROUTER_API_KEY: "synthetic-test-key" } as Env);
      const controller = new AbortController();
      const completion = runtime.models.completeSimple(runtime.models.getModel(runtime.model.provider, runtime.model.modelId), { messages: [{ role: "user", timestamp: 1, content: "synthetic input" }] }, { signal: controller.signal });
      await open;
      controller.abort();
      expect(await completion).toMatchObject({ stopReason: "aborted" });
      expect(requestSignal?.aborted).toBe(true);
      await closed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
