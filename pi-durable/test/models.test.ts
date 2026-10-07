import { afterEach, describe, expect, it, vi } from "vitest";
import { openRouterModels } from "../src/pi/models.js";
import type { Env } from "../src/env.js";

afterEach(() => vi.unstubAllEnvs());

describe("Workers model credentials", () => {
  it("resolves the Workers Secret, not ambient process.env", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "wrong-ambient-key");
    const runtime = openRouterModels({ OPENROUTER_API_KEY: "workers-secret" } as Env);
    expect((await runtime.models.getAuth("openrouter"))?.auth.apiKey).toBe("workers-secret");
    expect(runtime.models.getModel(runtime.model.provider, runtime.model.modelId)).toBeDefined();
  });

  it("fails safely for a missing Secret or unknown pinned model", () => {
    expect(() => openRouterModels({} as Env)).toThrow("Missing Workers Secret");
    expect(() => openRouterModels({ OPENROUTER_API_KEY: "workers-secret", PI_MODEL: "not-a-model" } as Env)).toThrow("pinned Pi model catalog");
  });
});
