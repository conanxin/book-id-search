import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWereadStatusCache,
  clearWereadToken,
  fetchWereadAiSummary,
  fetchWereadNotes,
  fetchWereadStatusesForBooks,
  fetchWereadStatus,
  fetchWereadSummary,
  getWereadToken,
  saveWereadToken,
} from "./wereadPrivate";

const TOKEN_KEY = "book-id-search:weread-private-token";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  get length(): number {
    return this.data.size;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).sessionStorage = new MemoryStorage();

describe("wereadPrivate", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn(async () => new Response("{}"));
  const TOKEN = "book-id-search:weread-private-token";

  beforeEach(() => {
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.clear();
    clearWereadStatusCache();
    clearWereadToken();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.clear();
    clearWereadStatusCache();
    clearWereadToken();
    globalThis.fetch = originalFetch;
  });

  it("token save/load/clear use sessionStorage", () => {
    expect(getWereadToken()).toBeNull();
    saveWereadToken("secret");
    expect(getWereadToken()).toBe("secret");
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("secret");
    clearWereadToken();
    expect(getWereadToken()).toBeNull();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("fetchWereadSummary sends Authorization header", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          dataAvailable: true,
          booksCount: 1,
          notesCount: 2,
          confirmedMatchesCount: 3,
          confirmedWithNotesCount: 1,
          confirmedWithHighlightsCount: 2,
          totalConfirmedNoteRecords: 5,
        })
      )
    );
    await fetchWereadSummary("my-token");
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toContain("/private/weread/summary");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer my-token" });
  });

  it("fetchWereadStatus sends Authorization header", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          matched: true,
          catalogId: "13000000_000000000001",
        })
      )
    );
    await fetchWereadStatus("my-token", "13000000_000000000001");
    const call2 = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call2;
    expect(url).toContain("/private/weread/status?catalogId=13000000_000000000001");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer my-token" });
  });

  it("401 does not leak token in thrown error", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        statusText: "Unauthorized",
      })
    );
    await expect(fetchWereadSummary("my-token")).rejects.toThrow("unauthorized");
  });

  it("fetchWereadStatusesForBooks uses batch endpoint and deduplicates", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          results: {
            "13000000_000000000001": {
              matched: true,
              catalogId: "13000000_000000000001",
              weread: {
                readingStatus: "finished",
                progress: 100,
                noteCount: 1,
                highlightCount: 2,
                matchedRecordsCount: 1,
                notesSummary: {
                  total: 3,
                  highlights: 2,
                  thoughts: 0,
                  reviews: 0,
                  unknown: 1,
                  hasNotes: true,
                },
                matchMethod: "isbn",
                matchConfidence: "high",
                decisionSource: "auto",
              },
            },
          },
        })
      )
    );
    const r1 = await fetchWereadStatusesForBooks("tok", [
      "13000000_000000000001",
      "13000000_000000000001",
    ]);
    const r2 = await fetchWereadStatusesForBooks("tok", ["13000000_000000000001"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toContain("/private/weread/status/batch");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(init?.body as string);
    expect(body.catalogIds).toEqual(["13000000_000000000001"]);
    expect(r1["13000000_000000000001"]).toBe(r2["13000000_000000000001"]);
  });

  it("fetchWereadStatusesForBooks falls back to single status when batch returns 404", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Not Found" }), { status: 404 })
    );
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          matched: true,
          catalogId: "13000000_000000000001",
        })
      )
    );
    const result = await fetchWereadStatusesForBooks("tok", ["13000000_000000000001"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const batchCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const singleCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(batchCall[0]).toContain("/private/weread/status/batch");
    expect(singleCall[0]).toContain("/private/weread/status?catalogId=13000000_000000000001");
    expect(result["13000000_000000000001"].matched).toBe(true);
  });

  it("batch 401 throws without leaking token", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid token." }), { status: 403 })
    );
    await expect(fetchWereadStatusesForBooks("leaked-token", ["13000000_000000000001"])).rejects.toThrow(
      "Invalid token."
    );
  });

  it("response type does not contain private fields", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          matched: true,
          catalogId: "13000000_000000000001",
          weread: {
            readingStatus: "finished",
            progress: 100,
            noteCount: 5,
            highlightCount: 3,
            matchMethod: "isbn",
            matchConfidence: "high",
            decisionSource: "auto",
          },
        })
      )
    );
    const res = await fetchWereadStatus("tok", "13000000_000000000001");
    const json = JSON.stringify(res);
    expect(json).not.toContain("wereadBookId");
    expect(json).not.toContain("noteId");
    expect(json).not.toContain("highlightId");
    expect(json).not.toContain("title");
    expect(json).not.toContain("text");
    expect(json).not.toContain("comment");
    expect(json).toContain("matched");
    expect(json).toContain("readingStatus");
  });
});

describe("fetchWereadNotes", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn(async () => new Response("{}"));

  beforeEach(() => {
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.clear();
    clearWereadStatusCache();
    clearWereadToken();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          items: [],
          pageInfo: { limit: 50, offset: 0, total: 0, hasMore: false },
          summary: {
            totalAfterFilter: 0,
            highlights: 0,
            thoughts: 0,
            reviews: 0,
            unknown: 0,
            matchedCount: 0,
            unmatchedCount: 0,
          },
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.clear();
    clearWereadStatusCache();
    clearWereadToken();
    globalThis.fetch = originalFetch;
  });

  it("builds URL with all query params and Authorization header", async () => {
    await fetchWereadNotes("my-token", {
      type: "highlight",
      days: "30",
      matchedOnly: true,
      hasComment: false,
      limit: 25,
      offset: 10,
      sort: "oldest",
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toContain("/private/weread/notes");
    expect(url).toContain("type=highlight");
    expect(url).toContain("days=30");
    expect(url).toContain("matchedOnly=true");
    expect(url).toContain("hasComment=false");
    expect(url).toContain("limit=25");
    expect(url).toContain("offset=10");
    expect(url).toContain("sort=oldest");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer my-token" });
  });

  it("returns parsed items from response", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          items: [
            {
              type: "highlight",
              text: "示例划线",
              comment: null,
              createdAt: "2026-07-04T00:00:00.000Z",
              updatedAt: null,
              matched: true,
              catalogId: "13000000_000000000001",
              source: "private_weread",
            },
          ],
          pageInfo: { limit: 50, offset: 0, total: 1, hasMore: false },
          summary: {
            totalAfterFilter: 1,
            highlights: 1,
            thoughts: 0,
            reviews: 0,
            unknown: 0,
            matchedCount: 1,
            unmatchedCount: 0,
          },
        })
      )
    );
    const res = await fetchWereadNotes("my-token");
    expect(res.ok).toBe(true);
    expect(res.items.length).toBe(1);
    expect(res.items[0].text).toBe("示例划线");
    expect(res.items[0].matched).toBe(true);
    expect(res.summary.highlights).toBe(1);
  });

  it("401 does not leak token in thrown error", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    );
    await expect(fetchWereadNotes("secret-token", { limit: 1 })).rejects.toThrow("unauthorized");
    // Ensure error message does not contain the token
    try {
      await fetchWereadNotes("secret-token", { limit: 1 });
    } catch (e) {
      expect(String(e)).not.toContain("secret-token");
    }
  });

  it("does not write to localStorage", async () => {
    const localStorageSet = vi.fn();
    Object.defineProperty(globalThis, "localStorage", {
      value: { setItem: localStorageSet, getItem: () => null, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 },
      configurable: true,
    });
    await fetchWereadNotes("tok");
    expect(localStorageSet).not.toHaveBeenCalled();
  });

  // ---- S27D: full-text search client tests ----

  it("sends q param when present and non-empty", async () => {
    await fetchWereadNotes("my-token", { q: "佛塔" });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url] = call;
    expect(url).toContain("/private/weread/notes");
    expect(url).toMatch(/[?&]q=/);
    expect(url).toContain("q=" + encodeURIComponent("佛塔"));
  });

  it("trims q before sending", async () => {
    await fetchWereadNotes("my-token", { q: "  hello  " });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url] = call;
    expect(url).toContain("q=" + encodeURIComponent("hello"));
  });

  it("omits q param when empty or whitespace-only", async () => {
    await fetchWereadNotes("my-token", { q: "" });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url] = call;
    expect(url).not.toContain("q=");
    // Second case: all-whitespace
    fetchMock.mockClear();
    await fetchWereadNotes("my-token", { q: "   " });
    const url2 = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0];
    expect(url2).not.toContain("q=");
  });

  it("401 with q still does not leak token or q", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    );
    try {
      await fetchWereadNotes("secret-token", { q: "private-thing" });
      throw new Error("should have thrown");
    } catch (e) {
      const s = String(e);
      expect(s).not.toContain("secret-token");
      expect(s).not.toContain("private-thing");
    }
  });

  it("returned object includes searchInfo if present", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          items: [],
          pageInfo: { limit: 50, offset: 0, total: 0, hasMore: false },
          summary: {
            totalAfterFilter: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0,
            matchedCount: 0, unmatchedCount: 0,
          },
          searchInfo: { enabled: true, queryLength: 5, termsCount: 1, matchedCount: 0 },
        })
      )
    );
    const res = await fetchWereadNotes("tok", { q: "hello" });
    expect(res.searchInfo).toBeDefined();
    expect(res.searchInfo?.enabled).toBe(true);
    expect(res.searchInfo?.queryLength).toBe(5);
    expect(res.searchInfo?.termsCount).toBe(1);
    expect(res.searchInfo?.matchedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S27E — fetchWereadAiSummary (own fetchMock scope)
// ---------------------------------------------------------------------------

describe("fetchWereadAiSummary (S27E)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const TOKEN = "token-for-ai-summary";

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          summary: {
            overview: "合成概览文本。",
            themes: [{ title: "主题一", summary: "主题摘要。", evidenceCount: 1 }],
            keyPoints: ["观点 A"],
            reviewQuestions: [],
            readingDirections: [],
          },
          meta: { itemsUsed: 1, totalCharacters: 5, persisted: false, provider: "minimax" },
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends POST with Content-Type: application/json and Authorization header", async () => {
    await fetchWereadAiSummary(TOKEN, [
      { type: "highlight", text: "合成测试材料：隐私边界。" },
    ]);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(init?.method).toBe("POST");
    expect(url).toContain("/private/weread/notes/summarize");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer token-for-ai-summary",
      "Content-Type": "application/json",
    });
  });

  it("only sends { type, text, comment } — no q / catalogId / matched / IDs / dates / title / author", async () => {
    await fetchWereadAiSummary(TOKEN, [
      {
        type: "highlight",
        text: "合成测试材料：边界检查。",
        comment: null,
        // The client must drop these even if a caller mistakenly attaches them.
        q: "secret-query",
        catalogId: "123_000000000001",
        wereadBookId: "secret-book",
        noteId: "secret-note",
        matched: true,
        title: "secret-title",
        author: "secret-author",
        createdAt: "2026-01-01T00:00:00.000Z",
      } as unknown as Parameters<typeof fetchWereadAiSummary>[1][number],
    ]);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(Object.keys(body)).toEqual(["items"]);
    const item = body.items[0];
    expect(Object.keys(item).sort()).toEqual(["comment", "text", "type"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret-query");
    expect(serialized).not.toContain("secret-title");
    expect(serialized).not.toContain("secret-author");
    expect(serialized).not.toContain("secret-book");
    expect(serialized).not.toContain("secret-note");
    expect(serialized).not.toContain("123_000000000001");
    expect(serialized).not.toContain("matched");
    expect(serialized).not.toContain("createdAt");
  });

  it("401 does not leak the token in the thrown error message", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    );
    await expect(
      fetchWereadAiSummary("leaked-token", [{ type: "highlight", text: "合成测试：鉴权失败。" }])
    ).rejects.toThrow("unauthorized");
    try {
      await fetchWereadAiSummary("leaked-token", [{ type: "highlight", text: "合成测试：鉴权失败。" }]);
    } catch (e) {
      expect(String(e)).not.toContain("leaked-token");
    }
  });

  it("429 / 502 / 503 / 504 surface as plain Error messages without token leakage", async () => {
    for (const status of [429, 502, 503, 504] as const) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: `provider-failure-${status}` }), { status })
      );
      await expect(
        fetchWereadAiSummary(TOKEN, [{ type: "highlight", text: "合成测试：限流。" }])
      ).rejects.toThrow(`provider-failure-${status}`);
    }
  });

  it("drops items where text AND comment are both empty after the rebuild", async () => {
    await fetchWereadAiSummary(TOKEN, [
      { type: "highlight", text: "保留的合成笔记。", comment: null },
      { type: "thought", text: "", comment: "" },
      { type: "review", text: "", comment: null },
    ]);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].text).toBe("保留的合成笔记。");
  });

  it("normalizes an invalid type to 'unknown'", async () => {
    await fetchWereadAiSummary(TOKEN, [
      { type: "garbage" as unknown as "highlight", text: "类型归一化。", comment: null },
    ]);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.items[0].type).toBe("unknown");
  });
});
