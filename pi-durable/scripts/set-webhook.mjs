import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { url: { type: "string" }, confirm: { type: "boolean", default: false } } });

async function main() {
  if (!values.url) throw new Error("Usage: pnpm telegram:webhook --url https://WORKER/telegram/webhook [--confirm]");
  const url = new URL(values.url);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/telegram/webhook" || url.search || url.hash) throw new Error("Expected an HTTPS /telegram/webhook URL without credentials or query parameters");
  if (!values.confirm) {
    console.log(`Would register Telegram webhook: ${url.href}`);
    console.log("Stop the old getUpdates poller first. No remote changes made; --confirm is required.");
    return;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN locally for this administrative operation");
  if (!secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) throw new Error("TELEGRAM_WEBHOOK_SECRET must be 16–256 letters, numbers, '_' or '-'");
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ url: url.href, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram rejected webhook registration (HTTP ${response.status})`);
  console.log("Webhook registered without discarding pending updates.");
}

main().catch(() => { console.error("Webhook configuration failed. Check the URL and local credentials; credentials are not logged."); process.exitCode = 1; });
