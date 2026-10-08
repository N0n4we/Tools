import type { AgentBackend } from "./agent.js";

export interface Env {
  AGENT: DurableObjectNamespace<AgentBackend>;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_USER_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OPENROUTER_API_KEY: string;
  PI_MODEL?: string;
  MEMORY_PREFIX?: string;
  WEB_SEARCH_PROVIDER?: string;
  BRAVE_SEARCH_API_KEY?: string;
  TAVILY_API_KEY?: string;
  WEB_ALLOWED_HOSTS?: string;
  TTS_MODEL?: string;
}

export function ownerId(env: Pick<Env, "TELEGRAM_USER_ID">): string {
  const value = env.TELEGRAM_USER_ID;
  if (!/^[1-9][0-9]*$/.test(value ?? "") || !Number.isSafeInteger(Number(value))) {
    throw new Error("TELEGRAM_USER_ID must be a positive safe integer");
  }
  return value;
}

export function requiredSecret(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Missing Workers Secret: ${name}`);
  return value;
}
