import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { url: { type: "string" }, confirm: { type: "boolean", default: false } } });

async function main() {
  if (!values.url) throw new Error("Usage: pnpm files:migrate --url https://WORKER/migrate-files [--confirm]");
  const url = new URL(values.url);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/migrate-files" || url.search || url.hash) throw new Error("Expected an HTTPS /migrate-files URL without credentials or query parameters");
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret?.trim()) throw new Error("Set TELEGRAM_WEBHOOK_SECRET locally for this administrative operation");
  const response = await fetch(url, {
    method: values.confirm ? "POST" : "GET", headers: { "x-telegram-bot-api-secret-token": secret },
    redirect: "error", signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Migration request failed (HTTP ${response.status}); inspect status before retrying`);
  console.log(JSON.stringify(await response.json()));
  if (!values.confirm) console.log("Status only; --confirm is required to migrate.");
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
