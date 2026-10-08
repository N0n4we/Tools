import type { Env } from "./env.js";
import { ownerId } from "./env.js";
import { AgentBackend } from "./agent.js";
import { HttpError, errorResponse, jsonBody, secretsEqual } from "./http.js";
import { telegramInput } from "./telegram.js";

export { AgentBackend };

function agent(env: Env) {
  return env.AGENT.get(env.AGENT.idFromName(ownerId(env)));
}

function internalRequest(path: string, body?: unknown): Request {
  return new Request(`https://agent.internal${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/telegram/webhook" && request.method === "POST") {
    if (!await secretsEqual(request.headers.get("x-telegram-bot-api-secret-token"), env.TELEGRAM_WEBHOOK_SECRET)) {
      throw new HttpError(401, "Invalid webhook secret");
    }
    const input = telegramInput(await jsonBody(request), ownerId(env));
    // Ignore other users, group chats, edited updates and unsupported media.
    if (!input) return Response.json({ ok: true, ignored: true });
    const response = await agent(env).fetch(internalRequest("/enqueue", {
      requestId: `telegram:${input.updateId}`, input: input.text, chatId: input.chatId, replyTo: input.messageId,
    }));
    if (!response.ok) return response;
    return Response.json({ ok: true, ...await response.json() as object });
  }
  throw new HttpError(404, "Not found");
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    let response: Response;
    try { response = await handle(request, env); } catch (error) {
      response = errorResponse(error);
    }
    response = new Response(response.body, response);
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  },
  async scheduled(_event, env, ctx) {
    // Cron is opt-in in wrangler.jsonc; Cloudflare cron expressions are UTC.
    ctx.waitUntil((async () => {
      const response = await agent(env).fetch(internalRequest("/wakeup"));
      if (!response.ok) throw new Error("Scheduled wakeup admission failed");
    })());
  },
};

export default worker;
