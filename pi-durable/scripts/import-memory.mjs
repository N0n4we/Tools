import { parseArgs } from "node:util";
import { collectMemoryFiles } from "./memory-files.mjs";

const { values } = parseArgs({ options: {
  source: { type: "string" }, url: { type: "string", default: "http://127.0.0.1:8787" },
  "dry-run": { type: "boolean", default: false }, overwrite: { type: "boolean", default: false },
  "allow-remote": { type: "boolean", default: false },
} });

async function main() {
  if (!values.source) throw new Error("Usage: pnpm memory:import --source DIRECTORY [--url URL] [--dry-run] [--overwrite] [--allow-remote]");
  const files = await collectMemoryFiles(values.source);
  if (values["dry-run"]) {
    for (const file of files) console.log(`${file.path}\t${file.bytes} bytes`);
    console.log(`${files.length} text files; ${files.reduce((sum, file) => sum + file.bytes, 0)} bytes. No files changed or uploaded.`);
    return;
  }
  const url = new URL(values.url);
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid backend URL");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local && (!values["allow-remote"] || url.protocol !== "https:")) throw new Error("Remote writes require HTTPS and explicit --allow-remote");
  const token = process.env.AGENT_ADMIN_TOKEN;
  if (!token || token.length < 32) throw new Error("Set AGENT_ADMIN_TOKEN in the local environment");
  const headers = { authorization: `Bearer ${token}` };
  for (const file of files) {
    const endpoint = new URL("/api/memory/file", url);
    endpoint.searchParams.set("path", file.path);
    const response = await fetch(endpoint, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Read failed (${response.status}): ${file.path}`);
    const previous = await response.json();
    if (previous.content === file.content && previous.etag) { console.log(`unchanged ${file.path}`); continue; }
    if (previous.etag && !values.overwrite) throw new Error(`Refusing to overwrite ${file.path}; use --overwrite explicitly`);
    const saved = await fetch(endpoint, {
      method: "PUT", headers: { ...headers, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ content: file.content, etag: previous.etag }),
    });
    if (!saved.ok) throw new Error(`Write failed (${saved.status}): ${file.path}. Concurrent changes are never overwritten.`);
    console.log(`saved ${file.path}`);
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
