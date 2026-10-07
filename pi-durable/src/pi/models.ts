import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { Env } from "../env.js";
import { requiredSecret } from "../env.js";

export interface AgentModels {
  models: Models;
  model: { provider: string; modelId: string };
}

export function openRouterModels(env: Env): AgentModels {
  requiredSecret(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY");
  const models = createModels({
    authContext: {
      env: async (name) => name === "OPENROUTER_API_KEY" ? env.OPENROUTER_API_KEY : undefined,
      fileExists: async () => false,
    },
  });
  models.setProvider(openrouterProvider());
  const modelId = env.PI_MODEL ?? "xiaomi/mimo-v2.6-flash";
  if (!models.getModel("openrouter", modelId)) throw new Error("PI_MODEL is not in the pinned Pi model catalog");
  return { models, model: { provider: "openrouter", modelId } };
}
