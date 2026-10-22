import { defineExtension, defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { HttpError } from "../http.js";
import { WebAccess } from "./access.js";

function inputs(single: string | undefined, multiple: string[] | undefined): string[] {
  const selected = multiple?.length ? multiple : single === undefined ? [] : [single];
  const values = [...new Set(selected.map(value => value.trim()).filter(Boolean))];
  if (!values.length) throw new HttpError(400, "Provide a non-empty query/queries or url/urls");
  return values;
}

async function batch<T>(values: string[], operation: (value: string) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  for (let index = 0; index < values.length; index += 3) {
    results.push(...await Promise.allSettled(values.slice(index, index + 3).map(operation)));
  }
  return results;
}

function errorText(error: unknown): string {
  return `Error: ${error instanceof HttpError ? error.message : "Web operation timed out or failed"}`;
}

export function webExtension(web: WebAccess) {
  const result = async (operation: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
    try { return await operation(); }
    catch (error) { return { output: [{ type: "text", text: errorText(error) }], isError: true }; }
  };
  return defineExtension({
    name: "web-access",
    tools: [
      defineTool({ name: "web_search", description: "Search the web and return source-linked results. For research, prefer queries with 2-4 varied angles over a single query. Omit provider to use the configured default; set it only to override that.", replay: "safe",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
          queries: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 4, description: "Multiple queries searched concurrently (up to three at a time). Vary phrasing, scope, and angle across 2-4 queries." })),
          numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)" })),
          provider: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("exa"), Type.Literal("brave"), Type.Literal("tavily")], { description: "Search provider; omit or use auto to use the configured default." })),
        }, { additionalProperties: false }),
        execute: (args, _api, context) => result(async () => {
          const queries = inputs(args.query, args.queries);
          const provider = !args.provider || args.provider === "auto" ? web.provider : args.provider;
          const results = await batch(queries, query => web.search(query, args.numResults, { provider, signal: context.abortSignal }));
          const text = results.map((result, index) => {
            const content = result.status === "rejected"
              ? errorText(result.reason)
              : result.value.map((entry, index) => `${index + 1}. ${entry.title}\n   ${entry.url}${entry.description ? `\n   ${entry.description}` : ""}`).join("\n\n") || "No results found.";
            return `${queries.length > 1 ? `## Query: "${queries[index]}"\n\n` : ""}${content}`;
          }).join("\n\n");
          return { output: [{ type: "text", text: `**Provider:** ${provider}\n\n${text}` }], isError: results.every(result => result.status === "rejected") };
        }),
      }),
      defineTool({ name: "fetch_content", description: "Fetch URL(s). Available modes: readable (default): extract readable text; raw: return the textual HTTP body without HTML extraction. Only public HTTPS HTML, text, and JSON are supported.", replay: "safe",
        parameters: Type.Object({
          url: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000, description: "Single URL to fetch" })),
          urls: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { minItems: 1, maxItems: 4, description: "Multiple URLs (parallel)" })),
          mode: Type.Optional(Type.Union([Type.Literal("readable"), Type.Literal("raw")], { description: "Fetch mode: readable (default) or raw." })),
        }, { additionalProperties: false }),
        execute: (args, _api, context) => result(async () => {
          const urls = inputs(args.url, args.urls);
          const results = await batch(urls, url => web.read(url, { mode: args.mode, signal: context.abortSignal }));
          const text = results.map((result, index) => {
            const content = result.status === "rejected" ? errorText(result.reason) : `${result.value.text}${result.value.truncated ? "\n\n[Content truncated; content retrieval is not registered.]" : ""}`;
            const url = result.status === "fulfilled" ? result.value.url : urls[index];
            const title = result.status === "fulfilled" ? result.value.title || url : url;
            return `${urls.length > 1 ? `### ${title}\n${url}\n\n` : ""}${content}`;
          }).join("\n\n");
          return { output: [{ type: "text", text }], isError: results.every(result => result.status === "rejected") };
        }),
      }),
    ],
  });
}
