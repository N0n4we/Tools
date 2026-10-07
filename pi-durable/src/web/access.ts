import ipaddr from "ipaddr.js";
import { Parser } from "htmlparser2";
import type { Env } from "../env.js";
import { HttpError, readLimited } from "../http.js";

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
  private readonly dnsCache = new Map<string, number>();

  constructor(private readonly env: Pick<Env, "WEB_ALLOWED_HOSTS" | "WEB_SEARCH_PROVIDER" | "BRAVE_SEARCH_API_KEY" | "TAVILY_API_KEY">, private readonly fetcher: Fetcher = fetch.bind(globalThis)) {}

  private async resolvePublic(url: URL, signal: AbortSignal): Promise<void> {
    const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (ipaddr.isValid(host)) return;
    if ((this.dnsCache.get(host) ?? 0) > Date.now()) return;
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
    if (this.dnsCache.size >= 128) this.dnsCache.clear();
    this.dnsCache.set(host, Date.now() + 30_000);
  }

  async read(input: string): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
    const signal = AbortSignal.timeout(15_000);
    let url = publicUrl(input, this.env.WEB_ALLOWED_HOSTS);
    for (let redirects = 0; redirects <= 4; redirects++) {
      await this.resolvePublic(url, signal);
      const response = await this.fetcher(url, {
        redirect: "manual", signal,
        headers: { accept: "text/html,text/plain,application/json;q=0.9", "user-agent": "PiDurableAgent/0.1" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new HttpError(502, "Redirect has no location");
        url = publicUrl(new URL(location, url).href, this.env.WEB_ALLOWED_HOSTS);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, `Web page returned HTTP ${response.status}`); }
      const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "application/json"].includes(type)) {
        await response.body?.cancel();
        throw new HttpError(415, "Only HTML and text/JSON pages are supported");
      }
      const body = await readLimited(response, MAX_WEB_BYTES);
      if (type.includes("html")) return { url: url.href, ...extractHtml(body) };
      return { url: url.href, title: "", text: body.slice(0, MAX_TEXT_CHARS), truncated: body.length > MAX_TEXT_CHARS };
    }
    throw new HttpError(502, "Too many redirects");
  }

  async search(query: string, count = 5): Promise<{ title: string; url: string; description: string }[]> {
    if (!query.trim() || query.length > 300) throw new HttpError(400, "Invalid search query");
    count = Math.max(1, Math.min(10, count));
    const provider = this.env.WEB_SEARCH_PROVIDER ?? "brave";
    let response: Response;
    if (provider === "brave") {
      if (!this.env.BRAVE_SEARCH_API_KEY) throw new HttpError(503, "Missing BRAVE_SEARCH_API_KEY Secret");
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));
      response = await this.fetcher(url, { headers: { "X-Subscription-Token": this.env.BRAVE_SEARCH_API_KEY, accept: "application/json" }, signal: AbortSignal.timeout(15_000), redirect: "manual" });
    } else if (provider === "tavily") {
      if (!this.env.TAVILY_API_KEY) throw new HttpError(503, "Missing TAVILY_API_KEY Secret");
      response = await this.fetcher("https://api.tavily.com/search", {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "manual", signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY, query, max_results: count, include_raw_content: false }),
      });
    } else { throw new HttpError(503, "WEB_SEARCH_PROVIDER must be brave or tavily"); }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, `Search provider returned HTTP ${response.status}`); }
    const json = JSON.parse(await readLimited(response, 512 * 1024)) as { web?: { results?: unknown[] }; results?: unknown[] };
    const results = provider === "brave" ? json.web?.results ?? [] : json.results ?? [];
    return results.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const entry = value as Record<string, unknown>;
      if (typeof entry.url !== "string") return [];
      let url: URL;
      try { url = publicUrl(entry.url, this.env.WEB_ALLOWED_HOSTS); } catch { return []; }
      return [{ title: String(entry.title ?? "").slice(0, 500), url: url.href, description: String(entry.description ?? entry.content ?? "").slice(0, 2_000) }];
    }).slice(0, count);
  }
}
