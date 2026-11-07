import type { ProviderStreams, TranscriptContext } from "@earendil-works/pi-ai";
import { HttpError } from "../http.js";
import { isStoredImage, type ImageStore } from "../image/store.js";

export type ImageReader = Pick<ImageStore, "read">;

export function imageContext(context: TranscriptContext, images?: ImageReader, signal?: AbortSignal): TranscriptContext {
  return { ...context, messages: context.messages.map(message => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    const content = (message.content as unknown[]).map(block => {
      if (!isStoredImage(block)) return block;
      signal?.throwIfAborted();
      if (!images) throw new HttpError(500, "Image storage is unavailable");
      return images.read(block);
    }) as typeof message.content;
    return { ...message, content };
  }) };
}

export function imageApi(api: ProviderStreams, images?: ImageReader): ProviderStreams {
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, imageContext(context, images, options?.signal), options),
    streamSimple: (model, context, options) => api.streamSimple(model, imageContext(context, images, options?.signal), options),
  };
}
