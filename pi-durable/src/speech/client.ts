import type { Env } from "../env.js";
import { HttpError, textField } from "../http.js";

export const MAX_SPEECH_CHARS = 1_000;
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

export class SpeechError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "SpeechError"; }
}

export class SpeechClient {
  constructor(private readonly env: Pick<Env, "OPENROUTER_API_KEY" | "TTS_MODEL">, private readonly fetcher: typeof fetch = fetch.bind(globalThis)) {}

  async generate(text: string, signal?: AbortSignal): Promise<Blob> {
    textField(text, "speech text", MAX_SPEECH_CHARS);
    if (!this.env.OPENROUTER_API_KEY?.trim()) throw new SpeechError("speech_not_configured");
    signal?.throwIfAborted();
    try {
      const response = await this.fetcher("https://openrouter.ai/api/v1/audio/speech", {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.env.OPENROUTER_API_KEY}` },
        body: JSON.stringify({ model: this.env.TTS_MODEL ?? "bytedance-seed/seed-audio-1-0", input: text, response_format: "mp3" }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      });
      // Discard provider errors, which may echo the input or credentials.
      if (!response.ok || response.status >= 300) {
        await response.body?.cancel();
        throw new SpeechError(response.status === 429 ? "speech_rate_limited" : "speech_provider_rejected");
      }
      const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (type !== "audio/mpeg" && type !== "audio/mp3") {
        await response.body?.cancel();
        throw new SpeechError("speech_expected_mp3");
      }
      if (Number(response.headers.get("content-length")) > MAX_AUDIO_BYTES) {
        await response.body?.cancel();
        throw new SpeechError("speech_audio_too_large");
      }
      if (!response.body) throw new SpeechError("speech_empty_audio");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_AUDIO_BYTES) {
            await reader.cancel();
            throw new SpeechError("speech_audio_too_large");
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      // Basic signature check, not a full decoder. Prevent JSON/HTML/PCM from
      // being uploaded as audio when a provider labels a response incorrectly.
      const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
      const frame = bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0 && ((bytes[1] ?? 0) & 6) === 2;
      if (size < 128 || (!id3 && !frame)) throw new SpeechError("speech_invalid_mp3");
      signal?.throwIfAborted();
      return new Blob([bytes], { type: "audio/mpeg" });
    } catch (error) {
      if (error instanceof SpeechError || error instanceof HttpError) throw error;
      throw new SpeechError(signal?.aborted ? "speech_cancelled" : "speech_network_failed");
    }
  }
}
