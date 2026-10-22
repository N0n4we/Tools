import { afterEach, describe, expect, it, vi } from "vitest";
import { openRouterModels } from "../src/pi/models.js";
import type { Env } from "../src/env.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Workers model credentials", () => {
  it("resolves the Workers Secret, not ambient process.env", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "wrong-ambient-key");
    const runtime = openRouterModels({ OPENROUTER_API_KEY: "workers-secret" } as Env);
    expect((await runtime.models.getAuth("openrouter"))?.auth.apiKey).toBe("workers-secret");
    expect(runtime.models.getModel(runtime.model.provider, runtime.model.modelId)).toMatchObject({ maxTokens: 80_000 });
  });

  it.each(["deepseek/deepseek-v4.1-flash-1017", "not-a-model"])("registers only the configured ID without a catalog or preflight request: %s", modelId => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const runtime = openRouterModels({ OPENROUTER_API_KEY: "workers-secret", PI_MODEL: modelId } as Env);
    expect(runtime.model).toEqual({ provider: "openrouter", modelId });
    expect(runtime.models.getModels("openrouter").map(model => model.id)).toEqual([modelId]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails safely for a missing Secret or empty model ID", () => {
    expect(() => openRouterModels({} as Env)).toThrow("Missing Workers Secret");
    expect(() => openRouterModels({ OPENROUTER_API_KEY: "workers-secret", PI_MODEL: "  " } as Env)).toThrow("Invalid PI_MODEL");
  });
});
