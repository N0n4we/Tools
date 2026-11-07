import type { ImageContent, ProviderStreams, StreamOptions, TextContent, TranscriptContext } from "@earendil-works/pi-ai";
import { HttpError } from "../http.js";
import { isVideoContent, MAX_VIDEO_BYTES, type VideoContent, type VideoStore } from "../video/store.js";

export type VideoReader = Pick<VideoStore, "dataUrl">;
export const MAX_VIDEO_CONTEXT_BYTES = 15 * 1024 * 1024;

// Pi 1.4's public content types cover text/images. Store the video extension as
// JSON, then adapt it only at the provider boundary to OpenRouter's video_url.
export function videoApi(api: ProviderStreams, videos?: VideoReader): ProviderStreams {
  function prepare<T extends StreamOptions>(context: TranscriptContext, options?: T) {
    const references = new Map<string, VideoContent>();
    const inputs = context.messages.flatMap(message => message.role === "user" && Array.isArray(message.content)
      ? (message.content as unknown[]).filter(isVideoContent) : []);
    let total = 0;
    for (const video of inputs) {
      if (!Number.isSafeInteger(video.size) || video.size < 1 || video.size > MAX_VIDEO_BYTES) throw new HttpError(413, "视频超过 20 MiB，请压缩或剪短后重发。");
      total += video.size;
    }
    let omitted = 0;
    // Keep the latest video even when it alone is 15–20 MiB. Earlier inputs
    // become text before loading bytes, leaving durable history unchanged.
    while (total > MAX_VIDEO_CONTEXT_BYTES && omitted < inputs.length - 1) total -= inputs[omitted++]!.size;
    let index = 0;
    const messages = context.messages.map(message => {
      if (message.role !== "user" || !Array.isArray(message.content)) return message;
      const blocks = (message.content as (TextContent | ImageContent | VideoContent)[]).map(block => {
        if (!isVideoContent(block)) return block;
        if (index++ < omitted) return { type: "text", text: "[video omitted]" } satisfies TextContent;
        const placeholder = `data:application/x-pi-video;base64,${block.id}`;
        references.set(placeholder, block);
        return { type: "image", mimeType: "application/x-pi-video", data: block.id } satisfies ImageContent;
      });
      return { ...message, content: blocks };
    });
    if (!references.size) return { context, options };
    return {
      context: { ...context, messages },
      options: {
        ...options,
        onPayload: async (payload: unknown, model: Parameters<NonNullable<StreamOptions["onPayload"]>>[1]) => {
          if (!videos) throw new HttpError(500, "Video storage is unavailable");
          const request = payload as { messages: { role: string; content?: unknown }[] };
          const converted = { ...request, messages: request.messages.map(message => {
            if (message.role !== "user" || !Array.isArray(message.content)) return message;
            return { ...message, content: message.content.map(part => {
              const video = part?.type === "image_url" ? references.get(part.image_url?.url) : undefined;
              if (!video) return part;
              return { type: "video_url", video_url: { url: videos.dataUrl(video, options?.signal) } };
            }) };
          }) };
          return await options?.onPayload?.(converted, model) ?? converted;
        },
      },
    };
  }
  return {
    ...api,
    stream(model, context, options) {
      const prepared = prepare(context, options);
      return api.stream(model, prepared.context, prepared.options);
    },
    streamSimple(model, context, options) {
      const prepared = prepare(context, options);
      return api.streamSimple(model, prepared.context, prepared.options);
    },
  };
}
