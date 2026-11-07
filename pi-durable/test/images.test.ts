import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import { ImageStore, type StoredImage } from "../src/image/store.js";
import { openRouterModels } from "../src/pi/models.js";
import { memoryDatabase } from "./helpers.js";
import type { Env } from "../src/env.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("stored batch images", () => {
  it("keeps maximum-sized images in separate rows and resolves references after reopening", async () => {
    const { storage, database } = memoryDatabase();
    const images = new ImageStore(storage as unknown as DurableObjectStorage);
    const image: ImageContent = { type: "image", mimeType: "image/png", data: Buffer.alloc(1024 * 1024).toString("base64") };
    const first = await images.save("first", image);
    const second = await images.save("second", image);
    expect(first.id).not.toBe(second.id);
    expect(await images.save("first", image)).toEqual(first);
    const reopened = new ImageStore(storage as unknown as DurableObjectStorage);
    for (const reference of [first, second]) expect(reopened.read(reference)).toEqual(image);
    expect(database.prepare("SELECT COUNT(*) AS count FROM telegram_images").get()).toMatchObject({ count: 2 });
    expect(() => reopened.read({ ...first, id: "missing" })).toThrow("图片附件缺失");
    expect(() => reopened.read({ ...first, mimeType: "image/jpeg" })).toThrow("图片附件缺失");
  });

  it.each(["complete", "completeSimple"] as const)("expands stored references into actual image bytes at the provider boundary (%s)", async mode => {
    const { storage } = memoryDatabase();
    const images = new ImageStore(storage as unknown as DurableObjectStorage);
    const reference = await images.save("first", { type: "image", mimeType: "image/png", data: "aW1hZ2U=" });
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return new Response('data: {"id":"image-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"收到。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }));
    const runtime = openRouterModels({ OPENROUTER_API_KEY: "fixture-key" } as Env, undefined, images);
    const user: UserMessage = { role: "user", timestamp: 1, content: [{ type: "text", text: "两张图" }, reference, reference] as UserMessage["content"] };
    const original = structuredClone(user);
    const result = await runtime.models[mode](runtime.models.getModel(runtime.model.provider, runtime.model.modelId), { messages: [user] });
    expect(result.stopReason).toBe("stop");
    expect(requests[0].messages[0].content).toEqual([
      { type: "text", text: "两张图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
    ]);
    expect(user).toEqual(original);
  });

  it("fails before sending a provider request when a referenced attachment is missing", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const { storage } = memoryDatabase();
    const images = new ImageStore(storage as unknown as DurableObjectStorage);
    const reference: StoredImage = { type: "image_ref", id: "missing", mimeType: "image/png" };
    const runtime = openRouterModels({ OPENROUTER_API_KEY: "fixture-key" } as Env, undefined, images);
    const result = await runtime.models.completeSimple(runtime.models.getModel(runtime.model.provider, runtime.model.modelId), { messages: [{ role: "user", timestamp: 1, content: [reference] as UserMessage["content"] }] });
    expect(result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("图片附件缺失") });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
