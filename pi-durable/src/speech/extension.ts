import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { HttpError } from "../http.js";
import { toolText } from "../memory/extension.js";
import { MAX_SPEECH_CHARS, SpeechError } from "./client.js";
import type { SpeechDelivery } from "./delivery.js";

export function speechExtension(delivery: SpeechDelivery, replyTo?: number, userJob = true) {
  return defineExtension({
    name: "telegram-speech",
    tools: [defineTool({
      name: "telegram_speak", description: "将用户要求朗读的文本生成 MP3 语音并立即发给配置的 Telegram owner。仅传文本，不接受收件人、URL 或密钥。每个用户请求最多一条；会产生 OpenRouter TTS 费用。",
      replay: "unsafe", executionMode: "sequential",
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: MAX_SPEECH_CHARS }) }, { additionalProperties: false }),
      execute: async (args, _api, context) => {
        try {
          if (!userJob) throw new SpeechError("speech_requires_user_request");
          return toolText(await delivery.send(args.text, replyTo, context.abortSignal));
        } catch (error) {
          return { ...toolText({ error: error instanceof SpeechError ? error.code : error instanceof HttpError ? error.message : "speech_failed", automaticRetry: false }), isError: true };
        }
      },
    })],
  });
}
