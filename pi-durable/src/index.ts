import type { Env } from "./env.js";
import { ownerId, requiredSecret } from "./env.js";
import { AgentBackend } from "./agent.js";
import { HttpError, errorResponse, jsonBody, secretsEqual, textField } from "./http.js";
import { TelegramBot, TelegramError, telegramInput } from "./telegram.js";

export { AgentBackend };

function agent(env: Env) {
  return env.AGENT.get(env.AGENT.idFromName(ownerId(env)));
}

function internalRequest(path: string, body?: unknown, method = "POST"): Request {
  return new Request(`https://agent.internal${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    return Response.json({ ok: true, runtime: "pi-durable" });
  }
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
  if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found");
  if (!env.AGENT_ADMIN_TOKEN || env.AGENT_ADMIN_TOKEN.length < 32) throw new HttpError(503, "Configure AGENT_ADMIN_TOKEN (at least 32 characters)");
  if (!await secretsEqual(request.headers.get("authorization"), `Bearer ${env.AGENT_ADMIN_TOKEN}`)) throw new HttpError(401, "Unauthorized");

  if (url.pathname === "/api/telegram/status" && request.method === "GET") {
    return Response.json(await new TelegramBot(requiredSecret(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN")).status(Number(ownerId(env))));
  }
  if (url.pathname === "/api/telegram/latest" && request.method === "GET") {
    return agent(env).fetch(internalRequest("/telegram/latest", undefined, "GET"));
  }
  if (url.pathname === "/api/telegram/webhook" && request.method === "POST") {
    if ((await jsonBody(request)).confirm !== true) throw new HttpError(400, "Explicit confirm:true is required; stop the old getUpdates poller first");
    // Fixed to this Worker's origin, not an arbitrary URL supplied by a caller.
    const target = `${url.origin}/telegram/webhook`;
    await new TelegramBot(requiredSecret(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN")).setWebhook(target, requiredSecret(env.TELEGRAM_WEBHOOK_SECRET, "TELEGRAM_WEBHOOK_SECRET"));
    return Response.json({ ok: true, url: target });
  }

  if (url.pathname === "/api/chat" && request.method === "POST") {
    const body = await jsonBody(request);
    return agent(env).fetch(internalRequest("/enqueue", {
      requestId: `api:${textField(body.requestId, "requestId", 128)}`,
      input: textField(body.text, "text", 8_000),
      ...(body.deliverToTelegram === true ? { chatId: Number(ownerId(env)) } : {}),
    }));
  }
  if (/^\/api\/jobs\/[a-f0-9]{64}$/.test(url.pathname) && request.method === "GET") {
    return agent(env).fetch(internalRequest(url.pathname.slice("/api".length), undefined, "GET"));
  }
  if (url.pathname === "/api/wakeup" && ["GET", "POST", "DELETE"].includes(request.method)) {
    return agent(env).fetch(internalRequest("/wakeup", request.method === "POST" ? await jsonBody(request) : undefined, request.method));
  }
  if (url.pathname === "/api/memory/files" && request.method === "GET") {
    return agent(env).fetch(internalRequest("/memory/files", undefined, "GET"));
  }
  if (url.pathname === "/api/memory/file" && ["GET", "PUT"].includes(request.method)) {
    // File operations and Pi tools must reach the same owner DO so revision
    // checks cannot race with edits from another Worker request.
    return agent(env).fetch(new Request(`https://agent.internal/memory/file${url.search}`, request));
  }
  throw new HttpError(404, "Not found");
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    let response: Response;
    try { response = await handle(request, env); } catch (error) {
      response = error instanceof TelegramError
        ? Response.json({ error: "Telegram API request failed", errorCode: error.errorCode, reason: error.reason, retryable: error.retryable, uncertain: error.uncertain }, { status: 502 })
        : errorResponse(error);
    }
    response = new Response(response.body, response);
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  },
  async scheduled(_event, env, ctx) {
    // Cron is opt-in in wrangler.jsonc; Cloudflare cron expressions are UTC.
    ctx.waitUntil((async () => {
      const response = await agent(env).fetch(internalRequest("/wakeup", {}));
      if (!response.ok) throw new Error("Scheduled wakeup admission failed");
    })());
  },
};

export default worker;
