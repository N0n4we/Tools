import { HttpError } from "../http.js";

export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
// Divisible by three, so independently encoded chunks concatenate as valid base64.
export const VIDEO_CHUNK_BYTES = 192 * 1024;
export type VideoMime = "video/mp4" | "video/webm" | "video/mpeg" | "video/mov";

export interface VideoContent {
  type: "video";
  id: string;
  mimeType: VideoMime;
  size: number;
}

export function isVideoContent(value: unknown): value is VideoContent {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "video";
}

export function videoBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 32_768) binary += String.fromCharCode(...bytes.subarray(start, start + 32_768));
  return btoa(binary);
}

type VideoRow = { id: string; mime_type: VideoMime; size: number };
const content = (row: VideoRow): VideoContent => ({ type: "video", id: row.id, mimeType: row.mime_type, size: row.size });

// Original bytes stay in the same DO as the conversation. History holds small,
// durable references; no SQLite row contains the whole video or its base64.
export class VideoStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS telegram_videos (
      id TEXT PRIMARY KEY, file_id TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, size INTEGER NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS telegram_video_chunks (
      video_id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (video_id, part)
    )`);
  }

  find(fileId: string): VideoContent | undefined {
    const row = this.storage.sql.exec<VideoRow>("SELECT id, mime_type, size FROM telegram_videos WHERE file_id = ?", fileId).toArray()[0];
    return row ? content(row) : undefined;
  }

  async save(fileId: string, bytes: Uint8Array<ArrayBuffer>, mimeType: VideoMime, signal?: AbortSignal): Promise<VideoContent> {
    if (!bytes.length || bytes.length > MAX_VIDEO_BYTES) throw new HttpError(413, "视频超过 20 MiB，请压缩或剪短后重发。");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fileId));
    const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    signal?.throwIfAborted();
    return this.storage.transactionSync(() => {
      const existing = this.find(fileId);
      if (existing) return existing;
      this.storage.sql.exec("INSERT INTO telegram_videos (id, file_id, mime_type, size) VALUES (?, ?, ?, ?)", id, fileId, mimeType, bytes.length);
      for (let start = 0, part = 0; start < bytes.length; start += VIDEO_CHUNK_BYTES, part++) {
        this.storage.sql.exec("INSERT INTO telegram_video_chunks (video_id, part, data) VALUES (?, ?, ?)", id, part, bytes.subarray(start, start + VIDEO_CHUNK_BYTES));
      }
      return { type: "video", id, mimeType, size: bytes.length };
    });
  }

  dataUrl(video: VideoContent, signal?: AbortSignal): string {
    const missing = () => new HttpError(502, "历史中的视频附件缺失或已损坏，请用 /pop 移除相关对话，或用 /new 开始新会话后重发。");
    if (!/^[a-f0-9]{64}$/.test(video.id)) throw missing();
    const row = this.storage.sql.exec<VideoRow>("SELECT id, mime_type, size FROM telegram_videos WHERE id = ?", video.id).toArray()[0];
    if (!row || row.mime_type !== video.mimeType || row.size !== video.size || row.size < 1 || row.size > MAX_VIDEO_BYTES) throw missing();
    const parts: string[] = [];
    let total = 0;
    for (const chunk of this.storage.sql.exec<{ part: number; data: ArrayBuffer }>("SELECT part, data FROM telegram_video_chunks WHERE video_id = ? ORDER BY part", video.id)) {
      signal?.throwIfAborted();
      const bytes = new Uint8Array(chunk.data);
      if (total >= row.size || chunk.part !== parts.length || bytes.length !== Math.min(VIDEO_CHUNK_BYTES, row.size - total)) throw missing();
      total += bytes.length;
      parts.push(videoBase64(bytes));
    }
    if (total !== row.size) throw missing();
    return `data:${video.mimeType};base64,${parts.join("")}`;
  }
}
