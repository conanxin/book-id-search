import { afterEach, describe, expect, it, vi } from "vitest";
import { searchMiniMaxWeb } from "./minimax-web-search.js";
import type { ChatMessage, MiniMaxConfig } from "./minimax.js";

const config: MiniMaxConfig = {
  apiKey: "fixture-provider-key-DO-NOT-RETURN",
  baseUrl: "https://provider.example.test/anthropic",
  model: "MiniMax-M3",
  wireApi: "anthropic",
};
const messages: ChatMessage[] = [
  { role: "system", content: "Search public book information. Use the web_search tool." },
  { role: "user", content: "中国古代旅行之研究 江绍原：查找相关研究。" },
];

function tool(id = "search-1", query = "中国古代旅行之研究 江绍原 相关研究") {
  return { type: "server_tool_use", id, name: "web_search", input: { query } };
}
function resultEntry(extra: Record<string, unknown> = {}) {
  return {
    type: "web_search_result", title: "某图书馆书目记录",
    url: "https://library.example.test/books/1", content: "江绍原，中国古代旅行之研究。",
    page_age: "2026-10-11", ...extra,
  };
}
function toolResult(content: unknown = [resultEntry()], tool_use_id = "search-1") {
  return { type: "web_search_tool_result", tool_use_id, content };
}
function completed(content: unknown[] = [tool(), toolResult()], extra: Record<string, unknown> = {}) {
  return {
    type: "message", role: "assistant", content, stop_reason: "end_turn",
    base_resp: { status_code: 0, status_msg: "" }, ...extra,
  };
}
function call(payload: unknown, options: Partial<MiniMaxConfig> = {}) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  return { fetchImpl, result: searchMiniMaxWeb(messages, { config: { ...config, ...options }, fetchImpl }) };
}
function abortableFetch() {
  return vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    const fail = () => reject(new DOMException("fixture abort secret", "AbortError"));
    if (init?.signal?.aborted) fail();
    else init?.signal?.addEventListener("abort", fail, { once: true });
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("MiniMax hosted search evidence", () => {
  it("declares the documented Anthropic server tool and returns paired result snapshots only", async () => {
    const request = call(completed([
      { type: "thinking", text: "Internal reasoning is not a search result." },
      { type: "text", text: "I searched https://invented.example.test/ and found invented prose." },
      tool(), toolResult(),
      { type: "text", text: "This generated answer must not become source evidence." },
    ]));
    expect(await request.result).toEqual({
      ok: true, queries: ["中国古代旅行之研究 江绍原 相关研究"], searchCalls: 1,
      results: [{
        title: "某图书馆书目记录", url: "https://library.example.test/books/1",
        excerpt: "江绍原，中国古代旅行之研究。", pageAge: "2026-10-11",
      }],
    });
    expect(request.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = request.fetchImpl.mock.calls[0];
    expect(url).toBe("https://provider.example.test/anthropic/v1/messages");
    expect(init).toMatchObject({
      method: "POST", headers: { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      model: "MiniMax-M3", system: messages[0].content, messages: [messages[1]],
      max_tokens: 4096, stream: false,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
  });

  it("keeps repeated observed queries and actual call counts, while normalizing and deduplicating URLs", async () => {
    const longExcerpt = "完整摘录".repeat(1200);
    expect(await call(completed([
      tool("search-1", "same query"),
      toolResult([resultEntry({ url: "https://LIBRARY.example.test:443/books/1#first", content: longExcerpt })]),
      tool("search-2", "same query"),
      toolResult([
        resultEntry({ url: "https://library.example.test/books/1#second", content: "Do not replace the first snapshot." }),
        resultEntry({ url: "http://library.example.test/books/2", page_age: null }),
      ], "search-2"),
    ])).result).toEqual({
      ok: true, queries: ["same query", "same query"], searchCalls: 2,
      results: [
        { title: "某图书馆书目记录", url: "https://library.example.test/books/1", excerpt: longExcerpt, pageAge: "2026-10-11" },
        { title: "某图书馆书目记录", url: "http://library.example.test/books/2", excerpt: "江绍原，中国古代旅行之研究。", pageAge: null },
      ],
    });
  });

  it("accepts an evidenced, completed search with no results", async () => {
    expect(await call(completed([tool(), toolResult([])])).result).toEqual({
      ok: true, queries: ["中国古代旅行之研究 江绍原 相关研究"], searchCalls: 1, results: [],
    });
  });

  it.each([
    [],
    [{ type: "text", text: JSON.stringify([tool(), toolResult()]) }],
    [{ type: "tool_use", id: "search-1", name: "web_search", input: { query: "claim" } }, toolResult()],
    [toolResult()],
    [tool()],
    [tool(), toolResult(undefined, "wrong-id")],
    [toolResult(), tool()],
    [tool(), tool(), toolResult()],
    [tool(), toolResult(), toolResult()],
    [tool(), toolResult(), tool("search-2", "unfinished second search")],
  ].map(content => ({ content })))("rejects fabricated, absent, unpaired or duplicate tool evidence %#", async ({ content }) => {
    expect(await call(completed(content)).result).toMatchObject({ ok: false, status: 502 });
  });

  it.each(["max_tokens", "tool_use", "pause_turn", "stop_sequence", null, undefined])(
    "rejects nonfinal stop reason %s even if it contains valid sources", async stop_reason => {
      expect(await call(completed(undefined, { stop_reason })).result).toMatchObject({ ok: false, status: 502 });
    },
  );

  it.each([
    { type: "error", error: { message: config.apiKey } },
    { role: "user" },
    { status: "failed" },
    { base_resp: { status_code: 1008, status_msg: config.apiKey } },
    { base_resp: null },
    { error: { message: config.apiKey } },
  ])("rejects failed or malformed top-level replies without echoing provider content %#", async extra => {
    const response = await call(completed(undefined, extra)).result;
    expect(response).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(response)).not.toContain(config.apiKey);
  });

  it.each([
    { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
    [{ type: "web_search_tool_result_error", error_code: "unavailable" }],
    [resultEntry(), { type: "error", message: config.apiKey }],
    [resultEntry({ is_error: true })],
    [resultEntry({ content: 42 })],
  ].map(content => ({ content })))("rejects tool failure or malformed snapshots instead of claiming an empty successful search %#", async ({ content }) => {
    expect(await call(completed([tool(), toolResult(content)])).result).toMatchObject({ ok: false, status: 502 });
  });

  it("discards non-result blocks, unsafe URLs and empty snippets", async () => {
    const unsafeUrls = [
      "javascript:alert(1)", "data:text/plain,hello", "/books/1", "//example.test/book",
      "https://owner:secret@example.test/book", "https://owner@example.test/book",
      "https://example.test/with space", "https://example.test/with\nnewline",
      "https://example.test\\path", "https://example.test/" + "x".repeat(4096),
    ];
    const response = await call(completed([tool(), toolResult([
      ...unsafeUrls.map(url => resultEntry({ url })),
      { type: "text", title: "Invented source", url: "https://invented.example.test/", content: "Invented" },
      resultEntry({ content: "  " }), null,
      resultEntry({ url: "https://valid.example.test", page_age: " " }),
    ])])).result;
    expect(response).toMatchObject({ ok: true, searchCalls: 1, results: [
      { url: "https://valid.example.test/", pageAge: null },
    ] });
  });

  it.each([
    [tool("", "query"), toolResult()],
    [tool("search-1", " "), toolResult()],
    [tool("search-1", "q".repeat(1001)), toolResult()],
    Array.from({ length: 13 }, (_, index) => [tool(`search-${index}`, "query"), toolResult([], `search-${index}`)]).flat(),
    [tool(), toolResult(Array.from({ length: 257 }, () => resultEntry()))],
  ].map(content => ({ content })))("rejects excessive or missing evidence fields without silently truncating the trace %#", async ({ content }) => {
    expect(await call(completed(content)).result).toMatchObject({ ok: false, status: 502 });
  });
});

describe("MiniMax search transport boundaries", () => {
  it.each(["responses", "openai_chat"] as const)("rejects the unsupported %s wire without a request", async wireApi => {
    const request = call(completed(), { wireApi });
    expect(await request.result).toMatchObject({ ok: false, status: 503 });
    expect(request.fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves the existing MiniMax environment configuration", async () => {
    vi.stubEnv("MINIMAX_API_KEY", config.apiKey);
    vi.stubEnv("MINIMAX_WIRE_API", "anthropic");
    vi.stubEnv("MINIMAX_BASE_URL", "https://configured.example.test/anthropic/");
    vi.stubEnv("MINIMAX_MODEL", "MiniMax-M3");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(completed())));
    expect(await searchMiniMaxWeb(messages, { fetchImpl })).toMatchObject({ ok: true });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://configured.example.test/anthropic/v1/messages");
  });

  it("does not send an unconfigured or oversized request", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "");
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await searchMiniMaxWeb(messages, { fetchImpl })).toMatchObject({ ok: false, status: 503 });
    expect(await searchMiniMaxWeb([{ role: "user", content: "q".repeat(32_001) }], { config, fetchImpl }))
      .toMatchObject({ ok: false, status: 502 });
    expect(await searchMiniMaxWeb([{ role: "system", content: "no user" }], { config, fetchImpl }))
      .toMatchObject({ ok: false, status: 502 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns safe HTTP and network errors and never retries", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(config.apiKey, { status: 429 }));
    expect(await searchMiniMaxWeb(messages, { config, fetchImpl }))
      .toEqual({ ok: false, error: "MiniMax web search HTTP 429", status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockReset().mockRejectedValue(new Error(`Network failed ${config.apiKey}`));
    expect(await searchMiniMaxWeb(messages, { config, fetchImpl }))
      .toEqual({ ok: false, error: "MiniMax web search request failed", status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["declared", "streamed"])("stops reading a %s response over 2 MiB", async kind => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel,
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, {
      headers: kind === "declared" ? { "Content-Length": String(2 * 1024 * 1024 + 1) } : {},
    }));
    expect(await searchMiniMaxWeb(messages, { config, fetchImpl })).toMatchObject({ ok: false, status: 502 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not expose malformed JSON or raw response content", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(config.apiKey));
    const response = await searchMiniMaxWeb(messages, { config, fetchImpl });
    expect(response).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(response)).not.toContain(config.apiKey);
  });

  it("does not start a request after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(config.apiKey);
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await searchMiniMaxWeb(messages, { config, fetchImpl, signal: controller.signal }))
      .toMatchObject({ ok: false, status: 499 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("propagates cancellation to fetch and cleans its listener and timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetchImpl = abortableFetch();
    const response = searchMiniMaxWeb(messages, { config, fetchImpl, signal: controller.signal });
    controller.abort(config.apiKey);
    expect(await response).toEqual({ ok: false, error: "MiniMax web search was cancelled", status: 499 });
    expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces its 90 second timeout separately from external cancellation", async () => {
    vi.useFakeTimers();
    const fetchImpl = abortableFetch();
    const response = searchMiniMaxWeb(messages, { config, fetchImpl });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await response).toEqual({ ok: false, error: "MiniMax web search timed out", status: 504 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans cancellation listeners and timers after success", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(completed())));
    expect(await searchMiniMaxWeb(messages, { config, fetchImpl, signal: controller.signal })).toMatchObject({ ok: true });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
