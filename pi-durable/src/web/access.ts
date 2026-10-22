import ipaddr from "ipaddr.js";
import { Parser } from "htmlparser2";
import type { BashOptions } from "just-bash/browser";
import type { Env } from "../env.js";
import { HttpError, readLimited, readLimitedBytes } from "../http.js";

type Fetcher = typeof fetch;
export const MAX_WEB_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 24_000;

export function publicAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed.range() === "unicast";
  } catch { return false; }
}

export function publicUrl(input: string, allowedHosts = ""): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new HttpError(400, "Invalid URL"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new HttpError(400, "Only HTTPS URLs without credentials on port 443 are allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (ipaddr.isValid(host)) {
    if (!publicAddress(host)) throw new HttpError(400, "Private or reserved network address");
  } else if (!host.includes(".") || /(?:^|\.)(localhost|local|internal|lan|test|invalid)$/.test(host)) {
    throw new HttpError(400, "Local network hostname is not allowed");
  }
  const allow = allowedHosts.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.some((value) => value.startsWith(".") ? host.endsWith(value) && host !== value.slice(1) : host === value)) {
    throw new HttpError(403, "Hostname is outside WEB_ALLOWED_HOSTS");
  }
  url.hash = "";
  return url;
}

export function extractHtml(html: string, maxChars = MAX_TEXT_CHARS): { title: string; text: string; truncated: boolean } {
  const ignored = new Set(["script", "style", "noscript", "svg", "nav", "footer", "template"]);
  const blocks = new Set(["p", "div", "article", "section", "br", "li", "h1", "h2", "h3", "h4", "tr"]);
  const stack: { skip: boolean; title: boolean }[] = [];
  let skip = 0;
  let titleDepth = 0;
  let title = "";
  let text = "";
  let truncated = false;
  const append = (value: string) => {
    const remaining = maxChars - text.length;
    if (value.length > remaining) truncated = true;
    if (remaining > 0) text += value.slice(0, remaining);
  };
  const parser = new Parser({
    onopentag(name) {
      const frame = { skip: ignored.has(name), title: name === "title" };
      stack.push(frame);
      if (frame.skip) skip++;
      if (frame.title) titleDepth++;
      if (!skip && blocks.has(name)) append("\n");
    },
    ontext(value) {
      if (titleDepth) title += value;
      else if (!skip) append(value);
    },
    onclosetag(name) {
      const frame = stack.pop();
      if (frame?.skip) skip--;
      if (frame?.title) titleDepth--;
      if (!skip && blocks.has(name)) append("\n");
    },
  }, { decodeEntities: true });
  parser.end(html);
  return { title: title.trim().slice(0, 500), text: text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim(), truncated };
}

export class WebAccess {
  constructor(private readonly env: Pick<Env, "WEB_ALLOWED_HOSTS" | "WEB_SEARCH_PROVIDER" | "EXA_API_KEY" | "BRAVE_SEARCH_API_KEY" | "TAVILY_API_KEY">, private readonly fetcher: Fetcher = fetch.bind(globalThis)) {}

  get provider(): string { return this.env.WEB_SEARCH_PROVIDER ?? "brave"; }

  private async resolvePublic(url: URL, signal: AbortSignal): Promise<void> {
    const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (ipaddr.isValid(host)) return;
    const addresses: string[] = [];
    for (const type of ["A", "AAAA"]) {
      const resolver = new URL("https://cloudflare-dns.com/dns-query");
      resolver.searchParams.set("name", host);
      resolver.searchParams.set("type", type);
      const response = await this.fetcher(resolver, { headers: { accept: "application/dns-json" }, signal, redirect: "manual" });
      if (!response.ok) throw new HttpError(502, "DNS preflight failed");
      const json = JSON.parse(await readLimited(response, 64 * 1024)) as { Status?: number; Answer?: { type: number; data: string }[] };
      if (json.Status !== 0) throw new HttpError(502, "DNS lookup failed");
      for (const answer of json.Answer ?? []) if (answer.type === 1 || answer.type === 28) addresses.push(answer.data);
    }
    if (!addresses.length || addresses.some((address) => !publicAddress(address))) {
      throw new HttpError(400, "Hostname resolves to a private/reserved address or has no public address");
    }
  }

  request: NonNullable<BashOptions["fetch"]> = async (input, options = {}) => {
    try {
      const method = (options.method ?? "GET").toUpperCase();
      if (!["GET", "HEAD"].includes(method) || options.body !== undefined) throw new HttpError(400, "Only GET and HEAD without a request body are allowed");
      let headers = new Headers(options.headers);
      if (headers.has("host")) throw new HttpError(400, "Overriding the Host header is not allowed");
      const signal = AbortSignal.any([AbortSignal.timeout(Math.ceil(Math.min(options.timeoutMs || 15_000, 15_000))), ...(options.signal ? [options.signal] : [])]);
      let url = publicUrl(input, this.env.WEB_ALLOWED_HOSTS);
      const requestedRedirects = options.maxRedirects ?? 4;
      const maxRedirects = Number.isFinite(requestedRedirects) ? Math.max(0, Math.min(Math.floor(requestedRedirects), 4)) : 4;
      const redirectChain = [];
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        // shortcut: Workers fetch cannot pin DNS answers; use an egress proxy for strict rebinding protection.
        await this.resolvePublic(url, signal);
        signal.throwIfAborted();
        const response = await this.fetcher(url, { method, headers, redirect: "manual", signal });
        const responseHeaders = Object.fromEntries(response.headers);
        if ([301, 302, 303, 307, 308].includes(response.status) && options.followRedirects !== false) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw new HttpError(502, "Redirect has no location");
          if (redirects >= maxRedirects) throw new HttpError(502, "Too many redirects");
          const next = publicUrl(new URL(location, url).href, this.env.WEB_ALLOWED_HOSTS);
          if (next.origin !== url.origin) headers = new Headers();
          redirectChain.push({ status: response.status, statusText: response.statusText, headers: responseHeaders });
          url = next;
          continue;
        }
        let body = new Uint8Array();
        if (method === "HEAD") await response.body?.cancel();
        else body = await readLimitedBytes(response, MAX_WEB_BYTES);
        signal.throwIfAborted();
        return { url: url.href, status: response.status, statusText: response.statusText, headers: responseHeaders, body, redirectChain };
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "Public HTTPS request failed or timed out");
    }
  };

  async read(input: string, options: { mode?: "readable" | "raw"; signal?: AbortSignal } = {}): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
    const response = await this.request(input, { headers: { accept: "text/html,text/plain,application/json;q=0.9", "user-agent": "PiDurableAgent/0.1" }, signal: options.signal });
    if (response.status < 200 || response.status >= 300) throw new HttpError(502, `Web page returned HTTP ${response.status}`);
    const type = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "application/json"].includes(type)) throw new HttpError(415, "Only HTML and text/JSON pages are supported");
    const body = new TextDecoder().decode(response.body);
    if (options.mode !== "raw" && type.includes("html")) return { url: response.url, ...extractHtml(body) };
    return { url: response.url, title: "", text: body.slice(0, MAX_TEXT_CHARS), truncated: body.length > MAX_TEXT_CHARS };
  }

  async search(query: string, numResults = 5, options: { provider?: string; signal?: AbortSignal } = {}): Promise<{ title: string; url: string; description: string }[]> {
    if (!query.trim() || query.length > 300) throw new HttpError(400, "Invalid search query");
    if (!Number.isInteger(numResults)) throw new HttpError(400, "Invalid result count");
    numResults = Math.max(1, Math.min(20, numResults));
    const provider = options.provider ?? this.provider;
    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]);
    signal.throwIfAborted();
    let response: Response;
    if (provider === "brave") {
      if (!this.env.BRAVE_SEARCH_API_KEY) throw new HttpError(503, "Missing BRAVE_SEARCH_API_KEY Secret");
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(numResults));
      response = await this.fetcher(url, { headers: { "X-Subscription-Token": this.env.BRAVE_SEARCH_API_KEY, accept: "application/json" }, signal, redirect: "manual" });
    } else if (provider === "tavily") {
      if (!this.env.TAVILY_API_KEY) throw new HttpError(503, "Missing TAVILY_API_KEY Secret");
      response = await this.fetcher("https://api.tavily.com/search", {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "manual", signal,
        body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY, query, max_results: numResults, include_raw_content: false }),
      });
    } else if (provider === "exa") {
      if (!this.env.EXA_API_KEY?.trim()) throw new HttpError(503, "Missing EXA_API_KEY Secret");
      response = await this.fetcher("https://api.exa.ai/search", {
        method: "POST", headers: { "content-type": "application/json", "x-api-key": this.env.EXA_API_KEY }, redirect: "manual", signal,
        body: JSON.stringify({ query, type: "auto", numResults, contents: { highlights: { maxCharacters: 2_000 } } }),
      });
    } else { throw new HttpError(503, "WEB_SEARCH_PROVIDER must be brave, tavily or exa"); }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, `Search provider returned HTTP ${response.status}`); }
    const json = JSON.parse(await readLimited(response, 512 * 1024)) as { web?: { results?: unknown[] }; results?: unknown[] };
    const results = provider === "brave" ? json.web?.results ?? [] : json.results ?? [];
    return results.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const entry = value as Record<string, unknown>;
      if (typeof entry.url !== "string") return [];
      let url: URL;
      try { url = publicUrl(entry.url, this.env.WEB_ALLOWED_HOSTS); } catch { return []; }
      const highlights = Array.isArray(entry.highlights) ? entry.highlights.filter(value => typeof value === "string").join("\n") : "";
      return [{ title: String(entry.title ?? "").slice(0, 500), url: url.href, description: String(entry.description ?? entry.content ?? (highlights || entry.text) ?? "").slice(0, 2_000) }];
    }).slice(0, numResults);
  }
}
