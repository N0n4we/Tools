import { HttpError } from "../http.js";
import type { TelegramVideo } from "../telegram.js";

export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_CONTEXT_BYTES = 15 * 1024 * 1024;
export const OMITTED_VIDEO = { type: "text", text: "[video omitted]" } as const;
export type VideoMime = "video/mp4" | "video/webm" | "video/mpeg" | "video/mov";

export interface VideoContent {
  type: "video";
  id: string;
  fileId: string;
  mimeType: VideoMime;
  size: number;
}

export function isVideoContent(value: unknown): value is VideoContent {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "video";
}

export function videoBase64(bytes: Uint8Array): string {
  // Each full slice is divisible by three, so only the last one can pad.
  const sliceBytes = 24_576;
  let encoded = "";
  for (let start = 0; start < bytes.length; start += sliceBytes) {
    encoded += btoa(String.fromCharCode(...bytes.subarray(start, start + sliceBytes)));
  }
  return encoded;
}

export function oldestVideosOverBudget(videos: readonly VideoContent[]): number {
  let total = 0;
  for (const video of videos) {
    if (!Number.isSafeInteger(video.size) || video.size < 1 || video.size > MAX_VIDEO_BYTES) throw new HttpError(413, "视频超过 20 MiB，请压缩或剪短后重发。");
    total += video.size;
  }
  let omitted = 0;
  while (total > MAX_VIDEO_CONTEXT_BYTES && omitted < videos.length - 1) total -= videos[omitted++]!.size;
  return omitted;
}

type Download = (video: TelegramVideo, signal?: AbortSignal) => Promise<{ bytes: Uint8Array; mimeType: VideoMime }>;

export class VideoSource {
  // One validated upload may be handed off to the first model request in memory.
  private pending?: { id: string; bytes: Uint8Array };

  constructor(private readonly download: Download) {}

  async prepare(id: string, video: TelegramVideo, signal: AbortSignal): Promise<VideoContent> {
    const { bytes, mimeType } = await this.download(video, signal);
    this.pending = { id, bytes };
    return { type: "video", id, fileId: video.fileId, mimeType, size: bytes.length };
  }

  clear(): void {
    this.pending = undefined;
  }

  async dataUrl(video: VideoContent, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const pending = this.pending?.id === video.id ? this.pending : undefined;
    if (pending) this.clear();
    let bytes = pending?.bytes;
    if (!bytes) {
      if (!video.fileId) throw new HttpError(502, "视频引用已失效，请在 Telegram 中重发视频。");
      const downloaded = await this.download({ fileId: video.fileId, fileSize: video.size }, signal);
      if (downloaded.bytes.length !== video.size || downloaded.mimeType !== video.mimeType) throw new HttpError(502, "Telegram 视频与原消息不一致，请重发视频。");
      bytes = downloaded.bytes;
    }
    return `data:${video.mimeType};base64,${videoBase64(bytes)}`;
  }
}
