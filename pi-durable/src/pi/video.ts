import type { ImageContent, ProviderStreams, StreamOptions, TextContent, TranscriptContext } from "@earendil-works/pi-ai";
import { HttpError } from "../http.js";
import { isVideoContent, oldestVideosOverBudget, OMITTED_VIDEO, type VideoContent, type VideoSource } from "../video/store.js";

export type VideoReader = Pick<VideoSource, "dataUrl">;

// Pi 1.4's public content types cover text/images. Store the video extension as
// JSON, then adapt it only at the provider boundary to OpenRouter's video_url.
export function videoApi(api: ProviderStreams, videos?: VideoReader): ProviderStreams {
  function prepare<T extends StreamOptions>(context: TranscriptContext, options?: T) {
    const references = new Map<string, VideoContent>();
    const inputs = context.messages.flatMap(message => message.role === "user" && Array.isArray(message.content)
      ? (message.content as unknown[]).filter(isVideoContent) : []);
    // Also enforce the budget for callers supplying a transcript directly.
    const omitted = oldestVideosOverBudget(inputs);
    let index = 0;
    const messages = context.messages.map(message => {
      if (message.role !== "user" || !Array.isArray(message.content)) return message;
      const blocks = (message.content as (TextContent | ImageContent | VideoContent)[]).map(block => {
        if (!isVideoContent(block)) return block;
        if (index++ < omitted) return OMITTED_VIDEO;
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
          if (!videos) throw new HttpError(500, "Telegram video source is unavailable");
          const request = payload as { messages: { role: string; content?: unknown }[] };
          // Resolve sequentially to bound transient video bytes in memory.
          const messages = [];
          for (const message of request.messages) {
            if (message.role !== "user" || !Array.isArray(message.content)) {
              messages.push(message);
              continue;
            }
            const content = [];
            for (const part of message.content) {
              const video = part?.type === "image_url" ? references.get(part.image_url?.url) : undefined;
              content.push(video ? { type: "video_url", video_url: { url: await videos.dataUrl(video, options?.signal) } } : part);
            }
            messages.push({ ...message, content });
          }
          const converted = { ...request, messages };
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
