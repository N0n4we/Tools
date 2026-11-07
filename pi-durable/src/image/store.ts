import type { ImageContent } from "@earendil-works/pi-ai";
import { HttpError } from "../http.js";

export interface StoredImage {
  type: "image_ref";
  id: string;
  mimeType: string;
}

export const isStoredImage = (value: unknown): value is StoredImage => !!value && typeof value === "object" && (value as { type?: unknown }).type === "image_ref";

// Each image is at most 1 MiB before base64. Store it in its own row so a
// multi-image input and Pi's inbox remain below SQLite's 2 MB row limit.
export class ImageStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS telegram_images (id TEXT PRIMARY KEY, mime_type TEXT NOT NULL, data TEXT NOT NULL)");
  }

  async save(fileId: string, image: ImageContent): Promise<StoredImage> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fileId));
    const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    this.storage.sql.exec("INSERT OR IGNORE INTO telegram_images (id, mime_type, data) VALUES (?, ?, ?)", id, image.mimeType, image.data);
    return { type: "image_ref", id, mimeType: image.mimeType };
  }

  read(image: StoredImage): ImageContent {
    const row = this.storage.sql.exec<{ mime_type: string; data: string }>("SELECT mime_type, data FROM telegram_images WHERE id = ?", image.id).toArray()[0];
    if (!row || row.mime_type !== image.mimeType) throw new HttpError(502, "历史中的图片附件缺失，请用 /pop 移除相关对话，或用 /new 开始新会话后重发。");
    return { type: "image", mimeType: row.mime_type, data: row.data };
  }
}
