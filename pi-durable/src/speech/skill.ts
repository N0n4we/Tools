import type { FsObject } from "@stablemodels/durable-bash/object";
import type { MemoryStorage } from "../memory/store.js";

const SPEECH_SKILL = `---
name: telegram-speech
description: 用户明确要求生成语音、朗读文字或用语音回复时使用。
---
# Telegram 语音

调用 telegram_speak，text 为朗读正文；服务端生成 MP3 并发送到 Telegram owner。
回执不确定表示可能已发送，需用户检查 Telegram；不可自动重试。
`;

export function installSpeechSkill(storage: MemoryStorage, files: Pick<FsObject, "exists" | "mkdir" | "writeFile">, prefix: string) {
  const directory = `/${prefix}skills/telegram-speech`;
  if (files.exists(`${directory}/SKILL.md`)) return;
  try {
    storage.transactionSync(() => {
      files.mkdir(`/${prefix}skills`, { recursive: true });
      files.mkdir(directory, { recursive: true });
      files.writeFile(`${directory}/SKILL.md`, SPEECH_SKILL);
    });
  } catch {
    // A path conflict or full namespace must not prevent normal conversations.
    console.warn("Could not initialize telegram-speech Skill");
  }
}
