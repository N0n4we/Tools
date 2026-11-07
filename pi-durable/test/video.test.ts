import { afterEach, describe, expect, it, vi } from "vitest";
import { openRouterModels } from "../src/pi/models.js";
import { MAX_VIDEO_BYTES, VIDEO_CHUNK_BYTES, videoBase64, type VideoContent } from "../src/video/store.js";
import type { Env } from "../src/env.js";
import type { UserMessage } from "@earendil-works/pi-ai";
import { MAX_VIDEO_CONTEXT_BYTES } from "../src/pi/video.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("native video transport", () => {
  it.each(["complete", "completeSimple"] as const)("sends persisted video references as video_url data URLs while preserving caption, image and history (%s)", async mode => {
    const video: VideoContent = { type: "video", id: "a".repeat(64), mimeType: "video/mp4", size: 16 };
    const bytes = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
    const videoUrl = `data:video/mp4;base64,${videoBase64(bytes)}`;
    const dataUrl = vi.fn(() => videoUrl);
    const payloads: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
      payloads.push(JSON.parse(init.body as string));
      return new Response('data: {"id":"video-test","object":"chat.completion.chunk","created":1,"model":"moonshotai/kimi-k3.1-pro","choices":[{"index":0,"delta":{"role":"assistant","content":"视频已读取。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }));
    const runtime = openRouterModels({ OPENROUTER_API_KEY: "fixture-key", PI_MODEL: "moonshotai/kimi-k3.1-pro" } as Env, { dataUrl });
    const message: UserMessage = { role: "user", timestamp: 1, content: [
      { type: "text", text: "请解释视频" }, video, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    ] as UserMessage["content"] };
    const original = structuredClone(message);
    const inspected: unknown[] = [];
    const answer = await runtime.models[mode](runtime.models.getModel(runtime.model.provider, runtime.model.modelId), { messages: [message] }, { onPayload(payload) { inspected.push(payload); } });
    expect(answer.stopReason).toBe("stop");
    expect(payloads[0].messages[0].content).toEqual([
      { type: "text", text: "请解释视频" }, { type: "video_url", video_url: { url: videoUrl } }, { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
    ]);
    expect(inspected).toEqual(payloads);
    expect(dataUrl).toHaveBeenCalledWith(video, undefined);
    expect(message).toEqual(original);
    expect(JSON.stringify(payloads)).not.toContain("application/x-pi-video");
  });

  it("rejects a single oversized video before materializing or sending a request", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const dataUrl = vi.fn();
    const runtime = openRouterModels({ OPENROUTER_API_KEY: "fixture-key" } as Env, { dataUrl });
    const content = [{ type: "video", id: "a".repeat(64), mimeType: "video/mp4", size: MAX_VIDEO_BYTES + 1 }];
    expect(await runtime.models.completeSimple(runtime.models.getModel(runtime.model.provider, runtime.model.modelId), { messages: [{ role: "user", timestamp: 1, content: content as unknown as UserMessage["content"] }] })).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("视频超过 20 MiB") });
    expect(dataUrl).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  describe.each(["complete", "completeSimple"] as const)("video context pruning (%s)", mode => {
    it.each([
      { sizes: [8, 8], omitted: 1 },
      { sizes: [5, 5, 5], omitted: 0 },
      { sizes: [6, 6, 6], omitted: 1 },
      { sizes: [8, 8, 8], omitted: 2 },
      { sizes: [4, 16], omitted: 1 },
      { sizes: [20], omitted: 0 },
      { sizes: [20, 1], omitted: 1 },
    ])("omits $omitted oldest videos for $sizes MiB while preserving the newest", async ({ sizes, omitted }) => {
      const videos: VideoContent[] = sizes.map((size, index) => ({ type: "video", id: String(index + 1).padStart(64, "0"), mimeType: "video/mp4", size: size * 1024 * 1024 }));
      const dataUrl = vi.fn((video: VideoContent) => `data:video/mp4;base64,${Buffer.from(video.id).toString("base64")}`);
      const payloads: any[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
        payloads.push(JSON.parse(init.body as string));
        return new Response('data: {"id":"video-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"收到。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      }));
      const runtime = openRouterModels({ OPENROUTER_API_KEY: "fixture-key" } as Env, { dataUrl });
      const messages: UserMessage[] = videos.map((video, index) => ({ role: "user", timestamp: index + 1, content: [{ type: "text", text: `说明 ${index + 1}` }, video] as UserMessage["content"] }));
      const original = structuredClone(messages);
      const result = await runtime.models[mode](runtime.models.getModel(runtime.model.provider, runtime.model.modelId), { messages });
      expect(result.stopReason).toBe("stop");
      expect(dataUrl.mock.calls.map(([video]) => video)).toEqual(videos.slice(omitted));
      for (let index = 0; index < videos.length; index++) {
        const content = payloads[0].messages[index].content;
        expect(content[0]).toEqual({ type: "text", text: `说明 ${index + 1}` });
        expect(content[1]).toEqual(index < omitted ? { type: "text", text: "[video omitted]" } : { type: "video_url", video_url: { url: `data:video/mp4;base64,${Buffer.from(videos[index]!.id).toString("base64")}` } });
      }
      expect(messages).toEqual(original);
      const remaining = videos.slice(omitted).reduce((sum, video) => sum + video.size, 0);
      expect(remaining <= MAX_VIDEO_CONTEXT_BYTES || videos.length - omitted === 1).toBe(true);
    });
  });

  it("encodes independent binary chunks without corrupting base64 at their boundaries", () => {
    const bytes = Uint8Array.from({ length: VIDEO_CHUNK_BYTES * 2 + 5 }, (_, index) => index % 256);
    const encoded: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += VIDEO_CHUNK_BYTES) encoded.push(videoBase64(bytes.subarray(offset, offset + VIDEO_CHUNK_BYTES)));
    expect(Buffer.from(encoded.join(""), "base64")).toEqual(Buffer.from(bytes));
  });
});
