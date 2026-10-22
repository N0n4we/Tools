import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { MAX_WEB_BYTES, WebAccess, extractHtml, publicAddress, publicUrl } from "../src/web/access.js";
import { webExtension } from "../src/web/extension.js";

function fixture(web: WebAccess) {
  const tools = webExtension(web).tools!;
  return (name: string, args: Record<string, unknown>, context = BACKGROUND_CONTEXT) => {
    const tool = tools.find(tool => tool.name === name)!;
    const validated = validateToolArguments(tool, { type: "toolCall", id: "web-test", name, arguments: args });
    return tool.execute(validated as never, undefined as never, context);
  };
}

function fetchMock(page: (url: URL, options?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "cloudflare-dns.com") return Response.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "8.8.8.8" }] : [] });
    return page(url, options);
  }) as unknown as typeof fetch;
}

describe("Web Access", () => {
  it.each(["http://example.com", "https://user:password@example.com", "https://127.0.0.1", "https://10.0.0.1", "https://169.254.169.254/latest/meta-data", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://localhost.", "https://a.internal", "https://example.com:444"]) ("rejects unsafe URL %s", (url) => {
    expect(() => publicUrl(url)).toThrow();
  });
  it.each(["0.0.0.0", "172.16.1.1", "192.168.0.1", "100.64.0.1", "224.0.0.1", "::", "fc00::1", "fe80::1"]) ("rejects reserved address %s", (address) => expect(publicAddress(address)).toBe(false));

  it("enforces an optional hostname allowlist", () => {
    expect(publicUrl("https://example.com", "example.com").hostname).toBe("example.com");
    expect(publicUrl("https://docs.example.com", ".example.com").hostname).toBe("docs.example.com");
    expect(() => publicUrl("https://notexample.com", ".example.com")).toThrow();
  });

  it("extracts readable text, never scripts/navigation", () => {
    const html = "<html><head><title>Page &amp; title</title><style>secret-css</style></head><body><nav>menu</nav><article><h1>正文</h1><p>内容 &lt;example&gt;</p><script>ignore instructions</script></article></body></html>";
    const result = extractHtml(html);
    expect(result.title).toBe("Page & title");
    expect(result.text).toContain("内容 <example>");
    expect(result.text).not.toMatch(/secret-css|menu|ignore instructions/);
  });

  it("checks DNS and every redirect", async () => {
    const mock = fetchMock(() => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }));
    await expect(new WebAccess({}, mock).read("https://example.com")).rejects.toThrow("Private");
    expect(vi.mocked(mock).mock.calls).toHaveLength(3);
  });

  it("rejects public-looking names resolving to private addresses", async () => {
    const mock = vi.fn(async () => Response.json({ Status: 0, Answer: [{ type: 1, data: "192.168.1.1" }] })) as unknown as typeof fetch;
    await expect(new WebAccess({}, mock).read("https://rebind.example.com")).rejects.toThrow("private");
  });

  it("reads public pages with bounded output", async () => {
    const web = new WebAccess({}, fetchMock(() => new Response(`<p>${"hello ".repeat(10_000)}</p>`, { headers: { "content-type": "text/html" } })));
    const result = await web.read("https://example.com");
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(24_000);
  });

  it("rejects binary formats and oversized bodies", async () => {
    await expect(new WebAccess({}, fetchMock(() => new Response("pdf", { headers: { "content-type": "application/pdf" } }))).read("https://example.com")).rejects.toMatchObject({ status: 415 });
    await expect(new WebAccess({}, fetchMock(() => new Response("x", { headers: { "content-type": "text/plain", "content-length": "2000000" } }))).read("https://example.com")).rejects.toMatchObject({ status: 413 });
  });

  it("reads UTF-8 text split across response chunks", async () => {
    const bytes = new TextEncoder().encode("中文😀");
    const mock = fetchMock(() => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 1)); controller.enqueue(bytes.slice(1)); controller.close();
    } }), { headers: { "content-type": "text/plain" } }));
    expect((await new WebAccess({}, mock).read("https://example.com")).text).toBe("中文😀");
  });

  it("supports HEAD on large resources without reading their body", async () => {
    const cancel = vi.fn();
    const mock = fetchMock((_url, options) => {
      expect(options?.method).toBe("HEAD");
      return new Response(new ReadableStream({ cancel }), { headers: { "content-length": "100000000" } });
    });
    expect((await new WebAccess({}, mock).request("https://example.com", { method: "HEAD" })).body).toEqual(new Uint8Array());
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([{ method: "POST" }, { body: "data" }, { headers: { Host: "internal" } }])("blocks unsafe request options before transport: %j", async options => {
    const mock = vi.fn() as unknown as typeof fetch;
    await expect(new WebAccess({}, mock).request("https://example.com", options)).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });

  it("preserves headers on same-origin redirects and drops all custom headers across origins", async () => {
    const mock = fetchMock((url, options) => {
      const headers = new Headers(options?.headers);
      if (url.hostname === "example.com") {
        for (const key of ["authorization", "cookie", "x-api-key"]) expect(headers.get(key)).toBe("private-value");
        return new Response(null, { status: 302, headers: { location: url.pathname === "/start" ? "/middle" : "https://other.example.org/end" } });
      }
      expect([...headers]).toEqual([]);
      return new Response("done");
    });
    const result = await new WebAccess({}, mock).request("https://example.com/start", { headers: { Authorization: "private-value", Cookie: "private-value", "x-api-key": "private-value" } });
    expect(result.url).toBe("https://other.example.org/end");
    expect(result.redirectChain).toHaveLength(2);
    expect(new TextDecoder().decode(result.body)).toBe("done");
  });

  it("checks DNS again on same-host redirects rather than trusting a stale answer", async () => {
    let lookups = 0;
    const mock = vi.fn(async input => {
      const url = new URL(String(input));
      if (url.hostname === "cloudflare-dns.com") return Response.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: ++lookups === 1 ? "8.8.8.8" : "127.0.0.1" }] : [] });
      return new Response(null, { status: 302, headers: { location: "/next" } });
    }) as unknown as typeof fetch;
    await expect(new WebAccess({}, mock).request("https://example.com/start")).rejects.toMatchObject({ status: 400 });
    expect(vi.mocked(mock).mock.calls.filter(([url]) => new URL(String(url)).hostname === "example.com")).toHaveLength(1);
  });

  it.each([[0, 1], [1, 2], [20, 5], [NaN, 5]])("caps redirect option %j at %i transport calls", async (maxRedirects, calls) => {
    const mock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/next" } })) as unknown as typeof fetch;
    await expect(new WebAccess({}, mock).request("https://8.8.8.8/start", { maxRedirects })).rejects.toThrow("Too many redirects");
    expect(mock).toHaveBeenCalledTimes(calls);
  });

  it("does not contact redirect targets when following is disabled", async () => {
    const mock = vi.fn(async () => new Response("redirect", { status: 302, headers: { location: "https://127.0.0.1/private" } })) as unknown as typeof fetch;
    expect((await new WebAccess({}, mock).request("https://8.8.8.8/start", { followRedirects: false })).status).toBe(302);
    expect(mock).toHaveBeenCalledOnce();
  });

  it("applies the hostname allowlist to redirect targets", async () => {
    const mock = fetchMock(() => new Response(null, { status: 302, headers: { location: "https://outside.example.org" } }));
    await expect(new WebAccess({ WEB_ALLOWED_HOSTS: "example.com" }, mock).request("https://example.com/start")).rejects.toMatchObject({ status: 403 });
    expect(vi.mocked(mock).mock.calls).toHaveLength(3);
  });

  it.each([[50, 50], [60000, 15000], [0, 15000]])("caps request timeout %i to %i ms", async (requested, expected) => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const mock = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    try {
      await new WebAccess({}, mock).request("https://8.8.8.8/data", { timeoutMs: requested });
      expect(timeout).toHaveBeenCalledWith(expected);
    } finally { timeout.mockRestore(); }
  });

  it("cancels advertised oversized responses and sanitizes transport errors", async () => {
    const cancel = vi.fn();
    const oversized = vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { "content-length": String(MAX_WEB_BYTES + 1) } })) as unknown as typeof fetch;
    await expect(new WebAccess({}, oversized).request("https://8.8.8.8/large")).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
    const failing = vi.fn(async () => { throw new Error("private transport detail"); }) as unknown as typeof fetch;
    await expect(new WebAccess({}, failing).request("https://8.8.8.8/fail")).rejects.toMatchObject({ status: 502, message: "Public HTTPS request failed or timed out" });
  });

  it("requires a provider Secret and filters unsafe search results", async () => {
    await expect(new WebAccess({}).search("test")).rejects.toThrow("BRAVE_SEARCH_API_KEY");
    const mock = vi.fn(async () => Response.json({ web: { results: [{ title: "page", url: "https://example.com", description: "result" }, { url: "http://localhost" }] } })) as unknown as typeof fetch;
    const results = await new WebAccess({ BRAVE_SEARCH_API_KEY: "test-key" }, mock).search("test");
    expect(results).toEqual([{ title: "page", url: "https://example.com/", description: "result" }]);
    expect(vi.mocked(mock).mock.calls[0]?.[1]).toMatchObject({ redirect: "manual", headers: { "X-Subscription-Token": "test-key" } });
  });

  it("supports Tavily and does not expose provider errors", async () => {
    const mock = vi.fn(async () => Response.json({ results: [{ title: "T", url: "https://example.com", content: "snippet" }] })) as unknown as typeof fetch;
    expect(await new WebAccess({ WEB_SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: "test-key" }, mock).search("query")).toHaveLength(1);
    const failing = vi.fn(async () => new Response("secret provider response", { status: 403 })) as unknown as typeof fetch;
    await expect(new WebAccess({ BRAVE_SEARCH_API_KEY: "test-key" }, failing).search("test")).rejects.toThrow("HTTP 403");
  });

  it.each([undefined, "", "   "])("requires an Exa Secret before sending a request: %j", async key => {
    const mock = vi.fn() as unknown as typeof fetch;
    await expect(new WebAccess({ WEB_SEARCH_PROVIDER: "exa", EXA_API_KEY: key }, mock).search("test")).rejects.toMatchObject({ status: 503, message: "Missing EXA_API_KEY Secret" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("uses Exa auto search and maps highlights to bounded snippets while filtering unsafe results", async () => {
    const mock = vi.fn(async () => Response.json({ results: [
      null, { url: "https://127.0.0.1/private" }, { url: "http://example.com" }, { url: "https://other.example.org/" },
      { title: "E".repeat(501), url: "https://example.com/#fragment", highlights: ["第一段", null, 42, "x".repeat(2_100)], text: "not used" },
      { title: "Fallback", url: "https://example.com/fallback", highlights: [], text: "正文摘录" },
      { title: "Extra", url: "https://example.com/extra", highlights: ["不应返回"] },
    ] })) as unknown as typeof fetch;
    const results = await new WebAccess({ WEB_SEARCH_PROVIDER: "exa", EXA_API_KEY: "test-exa-key", WEB_ALLOWED_HOSTS: "example.com" }, mock).search("中文 Exa query", 2);
    expect(results).toEqual([
      { title: "E".repeat(500), url: "https://example.com/", description: ("第一段\n" + "x".repeat(2_100)).slice(0, 2_000) },
      { title: "Fallback", url: "https://example.com/fallback", description: "正文摘录" },
    ]);
    const [url, options] = vi.mocked(mock).mock.calls[0]!;
    expect(url).toBe("https://api.exa.ai/search");
    expect(options).toMatchObject({ method: "POST", redirect: "manual", headers: { "x-api-key": "test-exa-key", "content-type": "application/json" } });
    expect(options!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options!.body as string)).toEqual({ query: "中文 Exa query", type: "auto", numResults: 2, contents: { highlights: { maxCharacters: 2_000 } } });
  });

  it.each([[0, 1], [20, 20], [21, 20]])("bounds Exa result count %i to %i", async (requested, expected) => {
    const mock = vi.fn(async () => Response.json({ results: [] })) as unknown as typeof fetch;
    await new WebAccess({ WEB_SEARCH_PROVIDER: "exa", EXA_API_KEY: "test-key" }, mock).search("test", requested);
    expect(JSON.parse(vi.mocked(mock).mock.calls[0]![1]!.body as string).numResults).toBe(expected);
  });

  it.each([401, 402, 429, 500])("does not expose or retry an Exa HTTP %i rejection", async status => {
    const mock = vi.fn(async () => new Response("secret provider response", { status })) as unknown as typeof fetch;
    await expect(new WebAccess({ WEB_SEARCH_PROVIDER: "exa", EXA_API_KEY: "test-key" }, mock).search("test")).rejects.toMatchObject({ status: 502, message: `Search provider returned HTTP ${status}` });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("bounds Exa response bodies", async () => {
    const mock = vi.fn(async () => new Response("private response", { headers: { "content-length": String(512 * 1024 + 1) } })) as unknown as typeof fetch;
    await expect(new WebAccess({ WEB_SEARCH_PROVIDER: "exa", EXA_API_KEY: "test-key" }, mock).search("test")).rejects.toMatchObject({ status: 413 });
  });

  it.each([
    { WEB_SEARCH_PROVIDER: "brave", BRAVE_SEARCH_API_KEY: "test-key" },
    { WEB_SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: "test-key" },
    { WEB_SEARCH_PROVIDER: "exa", EXA_API_KEY: "test-key" },
  ])("rejects $WEB_SEARCH_PROVIDER redirects rather than forwarding Secrets", async env => {
    const mock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://other.example/" } })) as unknown as typeof fetch;
    await expect(new WebAccess(env, mock).search("test")).rejects.toMatchObject({ status: 502 });
    expect(vi.mocked(mock).mock.calls).toHaveLength(1);
    expect(vi.mocked(mock).mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
});

describe("pi-web-access core tool interface", () => {
  it("provides the search/fetch tool names and rejects unsupported or obsolete parameters", () => {
    const web = new WebAccess({});
    expect(webExtension(web).tools!.map(tool => tool.name)).toEqual(["web_search", "fetch_content"]);
    const invoke = fixture(web);
    for (const args of [{ query: "test", count: 3 }, { query: "test", includeContent: true }, { query: "test", provider: "all" }, { query: "test", numResults: 21 }, { queries: Array(5).fill("test") }]) {
      expect(() => invoke("web_search", args)).toThrow();
    }
    for (const args of [{ url: "https://example.com", mode: "answer" }, { urls: Array(5).fill("https://example.com") }, { url: "https://example.com", auth: true }]) {
      expect(() => invoke("fetch_content", args)).toThrow();
    }
  });

  it.each([{}, { query: "   " }, { queries: [" "] }])("rejects empty search input without transport: %j", async args => {
    const mock = vi.fn() as unknown as typeof fetch;
    const result = await fixture(new WebAccess({}, mock))("web_search", args);
    expect(result.isError).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });

  it("searches unique trimmed queries with Pi's numResults and up to three concurrent requests", async () => {
    let active = 0;
    let maximum = 0;
    const queries: string[] = [];
    const mock = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      queries.push(body.query);
      expect(body.numResults).toBe(20);
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return Response.json({ results: [{ title: body.query, url: `https://example.com/${body.query}`, highlights: [`snippet ${body.query}`] }] });
    }) as unknown as typeof fetch;
    const invoke = fixture(new WebAccess({ WEB_SEARCH_PROVIDER: "exa", EXA_API_KEY: "private-test-key" }, mock));
    const result = await invoke("web_search", { queries: ["one", "two", "three", "four"], numResults: 20 });
    expect(result.isError).toBe(false);
    expect(queries).toEqual(["one", "two", "three", "four"]);
    expect(maximum).toBe(3);
    const output = JSON.stringify(result.output);
    for (const query of queries) expect(output).toContain(`https://example.com/${query}`);
    expect(output).toContain("snippet one");
    expect(output).not.toContain("private-test-key");
    queries.length = 0;
    await invoke("web_search", { query: "ignored", queries: [" one ", "one", "two"], numResults: 20 });
    expect(queries).toEqual(["one", "two"]);
  });

  it("uses the configured provider unless explicitly overridden, without fallback", async () => {
    const mock = vi.fn(async input => new URL(String(input)).hostname === "api.search.brave.com" ? Response.json({ web: { results: [] } }) : Response.json({ results: [] })) as unknown as typeof fetch;
    const invoke = fixture(new WebAccess({ WEB_SEARCH_PROVIDER: "exa", EXA_API_KEY: "exa-key", BRAVE_SEARCH_API_KEY: "brave-key" }, mock));
    for (const args of [{ query: "a" }, { query: "b", provider: "brave" }, { query: "c", provider: "auto" }]) {
      expect((await invoke("web_search", args)).isError).toBe(false);
    }
    expect(vi.mocked(mock).mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(["api.exa.ai", "api.search.brave.com", "api.exa.ai"]);
  });

  it("returns partial search successes and redacts transport errors", async () => {
    const mock = vi.fn(async (_url, options) => {
      if (JSON.parse(options.body).query === "bad") throw new Error("private-provider-key");
      return Response.json({ results: [{ title: "Good", url: "https://example.com", highlights: ["summary"] }] });
    }) as unknown as typeof fetch;
    const invoke = fixture(new WebAccess({ WEB_SEARCH_PROVIDER: "exa", EXA_API_KEY: "key" }, mock));
    const partial = await invoke("web_search", { queries: ["bad", "good"] });
    expect(partial.isError).toBe(false);
    expect(JSON.stringify(partial.output)).toContain("https://example.com/");
    expect(JSON.stringify(partial.output)).not.toContain("private-provider-key");
    expect((await invoke("web_search", { query: "bad" })).isError).toBe(true);
  });

  it("returns readable page text or the raw body without executing or rewriting it", async () => {
    const html = "  <title>Page</title><p>Hello &amp; world</p><script>untrusted()</script>\n";
    const invoke = fixture(new WebAccess({}, fetchMock(() => new Response(html, { headers: { "content-type": "text/html" } }))));
    const readable = await invoke("fetch_content", { url: "https://example.com" });
    expect(readable.output).toEqual([{ type: "text", text: "Hello & world" }]);
    const raw = await invoke("fetch_content", { url: "https://example.com", mode: "raw" });
    expect(raw.output).toEqual([{ type: "text", text: html }]);
  });

  it("fetches unique URLs, identifies partial errors, and does not promise nonexistent stored content", async () => {
    const mock = fetchMock(url => url.pathname === "/bad" ? new Response("private error body", { status: 500 }) : new Response("good body", { headers: { "content-type": "text/plain" } }));
    const invoke = fixture(new WebAccess({}, mock));
    const partial = await invoke("fetch_content", { urls: ["https://example.com/good", "https://example.com/bad", "https://example.com/good"] });
    expect(partial.isError).toBe(false);
    expect(JSON.stringify(partial.output)).toContain("good body");
    expect(JSON.stringify(partial.output)).toContain("https://example.com/bad");
    expect(JSON.stringify(partial.output)).not.toContain("private error body");
    expect(vi.mocked(mock).mock.calls.filter(([input]) => new URL(String(input)).hostname === "example.com")).toHaveLength(2);
    expect((await invoke("fetch_content", { url: "https://example.com/bad" })).isError).toBe(true);
    const bounded = await fixture(new WebAccess({}, fetchMock(() => new Response("x".repeat(24_001), { headers: { "content-type": "text/plain" } }))))("fetch_content", { url: "https://example.com" });
    expect(JSON.stringify(bounded.output)).toContain("truncated");
    expect(JSON.stringify(bounded.output)).not.toContain("get_search_content");
    expect(JSON.stringify(bounded.output)).not.toContain("responseId");
  });

  it.each(["web_search", "fetch_content"])("cancels %s transport without starting a later batch", async name => {
    const signals: AbortSignal[] = [];
    const mock = vi.fn(async (_url, options) => {
      signals.push(options.signal);
      return new Promise<Response>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("private transport detail")), { once: true }));
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const invoke = fixture(new WebAccess({ WEB_SEARCH_PROVIDER: "exa", EXA_API_KEY: "key" }, mock));
    const pending = invoke(name, name === "web_search" ? { queries: ["one", "two", "three", "four"] } : { urls: ["https://8.8.8.8/1", "https://8.8.8.8/2", "https://8.8.8.8/3", "https://8.8.8.8/4"] }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    await vi.waitFor(() => expect(signals).toHaveLength(3));
    controller.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(mock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result.output)).not.toContain("private transport detail");
  });
});
