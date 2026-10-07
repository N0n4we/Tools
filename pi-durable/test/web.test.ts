import { describe, expect, it, vi } from "vitest";
import { WebAccess, extractHtml, publicAddress, publicUrl } from "../src/web/access.js";

function fetchMock(page: (url: URL) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "cloudflare-dns.com") return Response.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "8.8.8.8" }] : [] });
    return page(url);
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
  it("rejects search-service redirects rather than forwarding Secrets", async () => {
    const mock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://other.example/" } })) as unknown as typeof fetch;
    await expect(new WebAccess({ BRAVE_SEARCH_API_KEY: "test-key" }, mock).search("test")).rejects.toMatchObject({ status: 502 });
    expect(vi.mocked(mock).mock.calls).toHaveLength(1);
    expect(vi.mocked(mock).mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
});
