import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Env } from "../env.js";
import { requiredSecret } from "../env.js";
import { textField } from "../http.js";

export interface AgentModels {
  models: Models;
  model: { provider: string; modelId: string };
}

export function openRouterModels(env: Env): AgentModels {
  const apiKey = requiredSecret(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY");
  const modelId = textField(env.PI_MODEL ?? "xiaomi/mimo-v2.6-flash", "PI_MODEL", 256);
  const models = createModels();
  models.setProvider(createProvider({
    id: "openrouter",
    auth: { apiKey: { name: "OpenRouter API key", resolve: async () => ({ auth: { apiKey } }) } },
    models: [{
      id: modelId, name: modelId, provider: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true, input: ["text"],
      // shortcut: limits match the current 1M-context models; adjust when switching to smaller models.
      contextWindow: 1_048_576, maxTokens: 131_072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStrictMode: true, requiresReasoningContentOnAssistantMessages: modelId.startsWith("deepseek/") },
    }],
    api: openAICompletionsApi(),
  }));
  return { models, model: { provider: "openrouter", modelId } };
}
